#!/usr/bin/env python3
"""
S3 Parquet Data Integrity Verifier

This script verifies that combined parquet files contain exactly the same data
as the original non-combined files. It performs comprehensive data integrity checks
including row counts, column schemas, data types, and content verification.

"""

import argparse
import boto3
import pyarrow as pa
import pyarrow.parquet as pq
import pandas as pd
import s3fs
from botocore.exceptions import ClientError
import logging
from typing import Dict, List, Tuple, Set
from collections import defaultdict
import hashlib
import json

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),  # Console output
    ]
)
logger = logging.getLogger(__name__)

# Uncomment the line below for more detailed debugging
# logger.setLevel(logging.DEBUG)

class S3ParquetVerifier:
    def __init__(self, bucket_name: str, prefix: str = "", aws_access_key_id: str = None,
                 aws_secret_access_key: str = None):
        """
        Initialize the S3 Parquet Verifier

        Args:
            bucket_name: Name of the S3 bucket
            prefix: Prefix path in S3 (e.g., 'database-export/')
            aws_access_key_id: AWS access key (optional, uses default credentials if None)
            aws_secret_access_key: AWS secret key (optional, uses default credentials if None)
        """
        self.bucket_name = bucket_name
        self.prefix = prefix.rstrip('/') + '/' if prefix else ''
        self.s3_client = boto3.client(
            's3',
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
        )

        # Initialize s3fs for PyArrow
        self.s3fs = s3fs.S3FileSystem(
            key=aws_access_key_id,
            secret=aws_secret_access_key,
        )

        # Verification results
        self.verification_results = {
            'tables_verified': 0,
            'tables_passed': 0,
            'tables_failed': 0,
            'total_original_files': 0,
            'total_combined_files': 0,
            'issues_found': []
        }

    def list_all_parquet_files(self) -> Dict[str, Dict[str, List[Tuple[str, int]]]]:
        """
        List all parquet files organized by table and type (original vs combined)

        Returns:
            Dictionary with table names as keys, each containing:
            - 'original': List of (file_key, size) tuples for original files
            - 'combined': List of (file_key, size) tuples for combined files
        """
        tables = defaultdict(lambda: {'original': [], 'combined': []})

        logger.info(f"Scanning S3 bucket: {self.bucket_name} with prefix: '{self.prefix}'")

        try:
            paginator = self.s3_client.get_paginator('list_objects_v2')
            page_iterator = paginator.paginate(
                Bucket=self.bucket_name,
                Prefix=self.prefix
            )

            total_files = 0
            for page in page_iterator:
                if 'Contents' not in page:
                    continue

                for obj in page['Contents']:
                    key = obj['Key']
                    size = obj['Size']
                    total_files += 1

                    # Skip if not a parquet file
                    if not key.lower().endswith('.parquet'):
                        continue

                    # Extract table name (first subdirectory after prefix)
                    relative_path = key[len(self.prefix):] if self.prefix else key
                    path_parts = relative_path.split('/')

                    if len(path_parts) >= 2:
                        table_name = path_parts[0]
                        filename = path_parts[-1]

                        # Classify as combined or original based on filename pattern
                        if filename.startswith('combined_') and 'MB.parquet' in filename:
                            tables[table_name]['combined'].append((key, size))
                        else:
                            tables[table_name]['original'].append((key, size))

                        logger.debug(f"Classified {key} as {'combined' if filename.startswith('combined_') else 'original'}")

            logger.info(f"Found {total_files} total files")

            # Log summary
            for table_name, files in tables.items():
                orig_count = len(files['original'])
                comb_count = len(files['combined'])
                logger.info(f"Table '{table_name}': {orig_count} original, {comb_count} combined files")

            return dict(tables)

        except ClientError as e:
            logger.error(f"Error listing S3 objects: {e}")
            raise

    def read_parquet_table(self, s3_key: str) -> pa.Table:
        """Read a parquet file from S3 and return as PyArrow table"""
        try:
            s3_path = f"s3://{self.bucket_name}/{s3_key}"
            logger.debug(f"Reading parquet file: {s3_path}")
            table = pq.read_table(s3_path, filesystem=self.s3fs)
            return table
        except Exception as e:
            logger.error(f"Error reading parquet file {s3_key}: {e}")
            raise

    def get_table_hash(self, table: pa.Table) -> str:
        """
        Generate a hash of the table data for comparison
        Converts to pandas and sorts to ensure consistent ordering
        """
        try:
            # Convert to pandas for consistent sorting
            df = table.to_pandas()

            # Sort by all columns to ensure consistent row ordering
            df_sorted = df.sort_values(by=list(df.columns)).reset_index(drop=True)

            # Create hash of the sorted data
            df_string = df_sorted.to_csv(index=False, header=True)
            return hashlib.md5(df_string.encode()).hexdigest()
        except Exception as e:
            logger.error(f"Error generating table hash: {e}")
            raise

    def compare_schemas(self, original_schema: pa.Schema, combined_schema: pa.Schema) -> List[str]:
        """Compare two PyArrow schemas and return list of differences"""
        issues = []

        # Check if schemas are equal
        if original_schema.equals(combined_schema):
            return issues

        # Compare field names
        orig_fields = {field.name: field for field in original_schema}
        comb_fields = {field.name: field for field in combined_schema}

        # Check for missing fields
        missing_in_combined = set(orig_fields.keys()) - set(comb_fields.keys())
        if missing_in_combined:
            issues.append(f"Fields missing in combined: {missing_in_combined}")

        extra_in_combined = set(comb_fields.keys()) - set(orig_fields.keys())
        if extra_in_combined:
            issues.append(f"Extra fields in combined: {extra_in_combined}")

        # Check field types for common fields
        common_fields = set(orig_fields.keys()) & set(comb_fields.keys())
        for field_name in common_fields:
            orig_type = orig_fields[field_name].type
            comb_type = comb_fields[field_name].type
            if not orig_type.equals(comb_type):
                issues.append(f"Field '{field_name}' type mismatch: {orig_type} vs {comb_type}")

        return issues

    def verify_table_data(self, table_name: str, original_files: List[Tuple[str, int]], 
                         combined_files: List[Tuple[str, int]]) -> Dict:
        """
        Verify that combined files contain exactly the same data as original files

        Returns:
            Dictionary with verification results
        """
        logger.info(f"Verifying table '{table_name}'...")

        result = {
            'table_name': table_name,
            'passed': False,
            'issues': [],
            'original_files_count': len(original_files),
            'combined_files_count': len(combined_files),
            'original_total_rows': 0,
            'combined_total_rows': 0,
            'original_total_size_mb': 0,
            'combined_total_size_mb': 0
        }

        try:
            # Read all original files
            logger.info(f"Reading {len(original_files)} original files...")
            original_tables = []
            for file_key, size in original_files:
                table = self.read_parquet_table(file_key)
                original_tables.append(table)
                result['original_total_size_mb'] += size / (1024 * 1024)

            # Combine original tables
            if original_tables:
                original_combined = pa.concat_tables(original_tables)
                result['original_total_rows'] = len(original_combined)
                original_schema = original_combined.schema
            else:
                result['issues'].append("No original files found")
                return result

            # Read all combined files
            logger.info(f"Reading {len(combined_files)} combined files...")
            combined_tables = []
            for file_key, size in combined_files:
                table = self.read_parquet_table(file_key)
                combined_tables.append(table)
                result['combined_total_size_mb'] += size / (1024 * 1024)

            # Combine combined tables
            if combined_tables:
                combined_combined = pa.concat_tables(combined_tables)
                result['combined_total_rows'] = len(combined_combined)
                combined_schema = combined_combined.schema
            else:
                result['issues'].append("No combined files found")
                return result

            # Verify row counts
            if result['original_total_rows'] != result['combined_total_rows']:
                result['issues'].append(
                    f"Row count mismatch: original={result['original_total_rows']}, "
                    f"combined={result['combined_total_rows']}"
                )

            # Verify schemas
            schema_issues = self.compare_schemas(original_schema, combined_schema)
            if schema_issues:
                result['issues'].extend(schema_issues)

            # Verify data content (if schemas match and row counts match)
            if not schema_issues and result['original_total_rows'] == result['combined_total_rows']:
                logger.info("Comparing data content...")

                # Generate hashes for comparison
                original_hash = self.get_table_hash(original_combined)
                combined_hash = self.get_table_hash(combined_combined)

                if original_hash != combined_hash:
                    result['issues'].append("Data content mismatch - hash comparison failed")

                    # Additional detailed comparison for small datasets
                    if result['original_total_rows'] < 100000:  # Only for smaller datasets
                        logger.info("Performing detailed row-by-row comparison...")
                        orig_df = original_combined.to_pandas().sort_values(by=list(original_combined.schema.names)).reset_index(drop=True)
                        comb_df = combined_combined.to_pandas().sort_values(by=list(combined_combined.schema.names)).reset_index(drop=True)

                        try:
                            pd.testing.assert_frame_equal(orig_df, comb_df, check_dtype=True, check_index_type=False)
                        except AssertionError as e:
                            result['issues'].append(f"Detailed comparison failed: {str(e)[:200]}...")
                else:
                    logger.info("✓ Data content verification passed")

            # Mark as passed if no issues found
            result['passed'] = len(result['issues']) == 0

            if result['passed']:
                logger.info(f"✓ Table '{table_name}' verification PASSED")
            else:
                logger.error(f"✗ Table '{table_name}' verification FAILED: {len(result['issues'])} issues found")
                for issue in result['issues']:
                    logger.error(f"  - {issue}")

            return result

        except Exception as e:
            result['issues'].append(f"Verification error: {str(e)}")
            logger.error(f"Error verifying table '{table_name}': {e}")
            return result

    def run_verification(self) -> Dict:
        """
        Run complete verification of all tables

        Returns:
            Dictionary with overall verification results
        """
        logger.info("Starting S3 Parquet data integrity verification...")

        # Test S3 connection
        try:
            response = self.s3_client.get_bucket_location(Bucket=self.bucket_name)
            logger.info(f"Connected to bucket (region: {response.get('LocationConstraint', 'us-east-1')})")
        except ClientError as e:
            logger.error(f"Failed to access bucket '{self.bucket_name}': {e}")
            return {'error': f"Cannot access bucket: {e}"}

        # List all files
        tables = self.list_all_parquet_files()

        if not tables:
            logger.warning("No tables found for verification")
            return {'error': "No tables found"}

        # Verify each table
        table_results = []
        for table_name, files in tables.items():
            original_files = files['original']
            combined_files = files['combined']

            if not original_files:
                logger.warning(f"No original files found for table '{table_name}' - skipping")
                continue

            if not combined_files:
                logger.warning(f"No combined files found for table '{table_name}' - skipping")
                continue

            # Verify this table
            result = self.verify_table_data(table_name, original_files, combined_files)
            table_results.append(result)

            # Update overall results
            self.verification_results['tables_verified'] += 1
            self.verification_results['total_original_files'] += len(original_files)
            self.verification_results['total_combined_files'] += len(combined_files)

            if result['passed']:
                self.verification_results['tables_passed'] += 1
            else:
                self.verification_results['tables_failed'] += 1
                self.verification_results['issues_found'].extend(result['issues'])

        # Generate final report
        self.verification_results['table_details'] = table_results
        self.verification_results['overall_passed'] = self.verification_results['tables_failed'] == 0

        self.print_verification_report()

        return self.verification_results

    def print_verification_report(self):
        """Print a comprehensive verification report"""
        print("\n" + "="*80)
        print("S3 PARQUET DATA INTEGRITY VERIFICATION REPORT")
        print("="*80)

        results = self.verification_results

        print(f"Overall Status: {'✓ PASSED' if results['overall_passed'] else '✗ FAILED'}")
        print(f"Tables Verified: {results['tables_verified']}")
        print(f"Tables Passed: {results['tables_passed']}")
        print(f"Tables Failed: {results['tables_failed']}")
        print(f"Original Files: {results['total_original_files']}")
        print(f"Combined Files: {results['total_combined_files']}")

        if results['table_details']:
            print("\nDetailed Results by Table:")
            print("-" * 40)

            for table_result in results['table_details']:
                status = "✓ PASS" if table_result['passed'] else "✗ FAIL"
                print(f"{table_result['table_name']}: {status}")
                print(f"  Original: {table_result['original_files_count']} files, "
                      f"{table_result['original_total_rows']:,} rows, "
                      f"{table_result['original_total_size_mb']:.2f} MB")
                print(f"  Combined: {table_result['combined_files_count']} files, "
                      f"{table_result['combined_total_rows']:,} rows, "
                      f"{table_result['combined_total_size_mb']:.2f} MB")

                if table_result['issues']:
                    print(f"  Issues: {len(table_result['issues'])}")
                    for issue in table_result['issues']:
                        print(f"    - {issue}")
                print()

        if not results['overall_passed']:
            print("\nSUMMARY OF ISSUES FOUND:")
            print("-" * 40)
            for issue in results['issues_found']:
                print(f"- {issue}")

        print("="*80)


def main():
    """Main function - Configure your S3 bucket and prefix here"""
    parser = argparse.ArgumentParser(description='Verify S3 Parquet data integrity')
    parser.add_argument('--bucket', required=True, help='S3 bucket name')
    parser.add_argument('--prefix', required=True, help='Source data prefix (do not pass a leading /)')

    args = parser.parse_args()

    logger.info(f"Configuration:")
    logger.info(f"  Bucket: {args.bucket}")
    logger.info(f"  Prefix: {args.prefix}")
    
    # Initialize and run verifier
    verifier = S3ParquetVerifier(args.bucket, args.prefix)
    results = verifier.run_verification()
    
    # Exit with appropriate code
    if results.get('overall_passed', False):
        logger.info("✓ All verifications passed!")
        exit(0)
    else:
        logger.error("✗ Verification failed!")
        exit(1)


if __name__ == "__main__":
    main()