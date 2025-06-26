#!/usr/bin/env python3
"""
S3 Parquet File Combiner

This script combines smaller Parquet files in S3 into larger files (~512MB) 
while maintaining the table subdirectory structure.

"""
import argparse
import boto3
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from botocore.exceptions import ClientError
import os
import tempfile
import logging
from typing import List, Tuple
from collections import defaultdict

# Configuration
TARGET_SIZE_MB = 512
TARGET_SIZE_BYTES = TARGET_SIZE_MB * 1024 * 1024
MIN_FILES_TO_COMBINE = 2  # Only combine if there are at least 2 files

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class S3ParquetCombiner:
    def __init__(self, bucket_name: str, prefix: str = ""):
        """
        Initialize the S3 Parquet Combiner

        Args:
            bucket_name: Name of the S3 bucket
            prefix: Prefix path in S3 (e.g., 'database-export/')
        """
        self.bucket_name = bucket_name
        self.prefix = prefix.rstrip('/') + '/' if prefix else ''
        self.s3_client = boto3.client('s3')

    def list_parquet_files_by_table(self) -> dict:
        """
        List all parquet files organized by table (top-level subdirectory)
        Handles nested subdirectories within each table

        Returns:
            Dictionary with table names as keys and list of (file_key, size, relative_path) tuples as values
        """
        tables = defaultdict(list)
        all_files_found = []
        parquet_files_found = []

        logger.info(f"Searching for files in S3 bucket: {self.bucket_name}")
        logger.info(f"Using prefix: '{self.prefix}'")

        try:
            paginator = self.s3_client.get_paginator('list_objects_v2')
            page_iterator = paginator.paginate(
                Bucket=self.bucket_name,
                Prefix=self.prefix
            )

            total_objects = 0
            for page in page_iterator:
                if 'Contents' not in page:
                    logger.warning(f"No 'Contents' found in page - bucket may be empty or prefix may not exist")
                    continue

                for obj in page['Contents']:
                    key = obj['Key']
                    size = obj['Size']
                    total_objects += 1

                    all_files_found.append(key)

                    # Log first few files for debugging
                    if len(all_files_found) <= 10:
                        logger.debug(f"Found file: {key} ({size} bytes)")

                    # Skip if not a parquet file
                    if not key.lower().endswith('.parquet'):
                        continue

                    parquet_files_found.append(key)

                    # Extract table name (first subdirectory after prefix)
                    relative_path = key[len(self.prefix):] if self.prefix else key
                    path_parts = relative_path.split('/')

                    logger.debug(f"Processing parquet file: {key}")
                    logger.debug(f"  Relative path: {relative_path}")
                    logger.debug(f"  Path parts: {path_parts}")

                    if len(path_parts) >= 2:  # At least table/...file.parquet
                        table_name = path_parts[0]
                        # Store the relative path within the table for organizing combined files
                        file_relative_path = '/'.join(path_parts[1:-1]) if len(path_parts) > 2 else ''
                        tables[table_name].append((key, size, file_relative_path))
                        logger.debug(f"  Added to table '{table_name}', subdir: '{file_relative_path}'")
                    else:
                        logger.warning(f"Skipping parquet file with insufficient path depth: {key}")

            # Summary logging
            logger.info(f"Search completed:")
            logger.info(f"  Total objects found: {total_objects}")
            logger.info(f"  Total parquet files found: {len(parquet_files_found)}")
            logger.info(f"  Tables identified: {len(tables)}")

            if total_objects == 0:
                logger.error(f"No objects found in bucket '{self.bucket_name}' with prefix '{self.prefix}'")
                logger.error("Possible issues:")
                logger.error("  1. Bucket name is incorrect")
                logger.error("  2. Prefix path is incorrect")
                logger.error("  3. AWS credentials don't have ListBucket permission")
                logger.error("  4. Bucket is empty")

            if total_objects > 0 and len(parquet_files_found) == 0:
                logger.warning("Files were found but none have .parquet extension")
                logger.info("Sample of files found:")
                for i, file_key in enumerate(all_files_found[:20]):
                    logger.info(f"  {file_key}")
                    if i >= 19 and len(all_files_found) > 20:
                        logger.info(f"  ... and {len(all_files_found) - 20} more files")
                        break

            if len(parquet_files_found) > 0:
                logger.info("Sample of parquet files found:")
                for i, file_key in enumerate(parquet_files_found[:10]):
                    logger.info(f"  {file_key}")
                    if i >= 9 and len(parquet_files_found) > 10:
                        logger.info(f"  ... and {len(parquet_files_found) - 10} more parquet files")
                        break

            for table_name, files in tables.items():
                logger.info(f"Table '{table_name}': {len(files)} parquet files")

            return dict(tables)

        except ClientError as e:
            logger.error(f"Error listing S3 objects: {e}")
            logger.error("This could be due to:")
            logger.error("  1. Incorrect bucket name")
            logger.error("  2. Insufficient AWS permissions (need s3:ListBucket)")
            logger.error("  3. Incorrect AWS credentials or region")
            raise

    def group_files_for_combining(self, files: List[Tuple[str, int, str]]) -> dict:
        """
        Group files that should be combined together based on target size and subdirectory
        Files from different subdirectories within a table are kept separate

        Args:
            files: List of (file_key, size, relative_path) tuples

        Returns:
            Dictionary with subdirectory paths as keys and list of groups as values
            Each group is a list of (file_key, size, relative_path) tuples
        """
        # First, organize files by subdirectory within the table
        files_by_subdir = defaultdict(list)
        for file_key, file_size, relative_path in files:
            files_by_subdir[relative_path].append((file_key, file_size, relative_path))

        # Now group files within each subdirectory
        all_groups = {}

        for subdir_path, subdir_files in files_by_subdir.items():
            # Sort files by size (smallest first for better packing)
            files_sorted = sorted(subdir_files, key=lambda x: x[1])

            groups = []
            current_group = []
            current_size = 0

            for file_key, file_size, rel_path in files_sorted:
                # If file is already larger than target, it goes in its own group
                if file_size >= TARGET_SIZE_BYTES:
                    if current_group:
                        groups.append(current_group)
                        current_group = []
                        current_size = 0
                    groups.append([(file_key, file_size, rel_path)])
                    continue

                # If adding this file would exceed target size, start new group
                if current_size + file_size > TARGET_SIZE_BYTES and current_group:
                    groups.append(current_group)
                    current_group = [(file_key, file_size, rel_path)]
                    current_size = file_size
                else:
                    current_group.append((file_key, file_size, rel_path))
                    current_size += file_size

            # Add the last group if it exists
            if current_group:
                groups.append(current_group)

            # Only keep groups that have multiple files or are close to target size
            valid_groups = [group for group in groups if len(group) >= MIN_FILES_TO_COMBINE or 
                           sum(size for _, size, _ in group) >= TARGET_SIZE_BYTES * 0.8]

            if valid_groups:
                all_groups[subdir_path] = valid_groups

        return all_groups

    def download_parquet_file(self, s3_key: str, local_path: str):
        """Download a parquet file from S3 to local storage"""
        try:
            self.s3_client.download_file(self.bucket_name, s3_key, local_path)
        except ClientError as e:
            logger.error(f"Error downloading {s3_key}: {e}")
            raise

    def upload_parquet_file(self, local_path: str, s3_key: str):
        """Upload a parquet file from local storage to S3"""
        try:
            self.s3_client.upload_file(local_path, self.bucket_name, s3_key)
        except ClientError as e:
            logger.error(f"Error uploading {s3_key}: {e}")
            raise

    def delete_s3_files(self, s3_keys: List[str]):
        """Delete multiple files from S3"""
        if not s3_keys:
            return

        try:
            objects_to_delete = [{'Key': key} for key in s3_keys]
            self.s3_client.delete_objects(
                Bucket=self.bucket_name,
                Delete={'Objects': objects_to_delete}
            )
            logger.info(f"Deleted {len(s3_keys)} files from S3")
        except ClientError as e:
            logger.error(f"Error deleting files: {e}")
            raise

    def combine_parquet_files(self, file_group: List[Tuple[str, int, str]], output_key: str):
        """
        Combine multiple parquet files into a single file

        Args:
            file_group: List of (file_key, size, relative_path) tuples to combine
            output_key: S3 key for the combined output file
        """
        with tempfile.TemporaryDirectory() as temp_dir:
            # Download all files
            local_files = []
            for i, (s3_key, _, _) in enumerate(file_group):
                local_file = os.path.join(temp_dir, f"input_{i}.parquet")
                self.download_parquet_file(s3_key, local_file)
                local_files.append(local_file)

            # Read and combine parquet files
            try:
                # Read all parquet files and concatenate
                dfs = []
                for local_file in local_files:
                    df = pd.read_parquet(local_file)
                    dfs.append(df)

                # Combine all dataframes
                combined_df = pd.concat(dfs, ignore_index=True)

                # Write combined file
                output_file = os.path.join(temp_dir, "combined.parquet")
                combined_df.to_parquet(output_file, index=False)

                # Upload combined file
                self.upload_parquet_file(output_file, output_key)

                # Maybe in the future - Delete original files
                # original_keys = [key for key, _, _ in file_group]
                # self.delete_s3_files(original_keys)

                logger.info(f"Combined {len(file_group)} files into {output_key}")

            except Exception as e:
                logger.error(f"Error combining files: {e}")
                raise

    def process_table(self, table_name: str, files: List[Tuple[str, int, str]]):
        """Process all files for a single table, handling nested subdirectories"""
        logger.info(f"Processing table: {table_name} ({len(files)} files)")

        # Calculate total size
        total_size_mb = sum(size for _, size, _ in files) / (1024 * 1024)
        logger.info(f"Total size: {total_size_mb:.2f} MB")

        # Group files for combining by subdirectory
        groups_by_subdir = self.group_files_for_combining(files)

        if not groups_by_subdir:
            logger.info(f"No files need combining for table {table_name}")
            return

        total_combined_files = sum(len(groups) for groups in groups_by_subdir.values())
        logger.info(f"Will create {total_combined_files} combined files across {len(groups_by_subdir)} subdirectories for table {table_name}")

        # Process each subdirectory
        for subdir_path, groups in groups_by_subdir.items():
            subdir_display = f"/{subdir_path}" if subdir_path else " (root)"
            logger.info(f"Processing subdirectory{subdir_display}: {len(groups)} combined files")

            # Process each group within the subdirectory
            for i, group in enumerate(groups):
                if len(group) == 1:
                    logger.info(f"Skipping single file: {group[0][0]}")
                    continue

                # Generate output filename with subdirectory structure preserved
                group_size_mb = sum(size for _, size, _ in group) / (1024 * 1024)

                # Create output path maintaining subdirectory structure
                if subdir_path:
                    output_key = f"{self.prefix}{table_name}/{subdir_path}/combined_{i+1:03d}_{group_size_mb:.0f}MB.parquet"
                else:
                    output_key = f"{self.prefix}{table_name}/combined_{i+1:03d}_{group_size_mb:.0f}MB.parquet"

                logger.info(f"Combining {len(group)} files ({group_size_mb:.2f} MB) -> {output_key}")
                self.combine_parquet_files(group, output_key)

    def run(self):
        """Main execution method"""
        logger.info(f"Starting parquet file combination for bucket: {self.bucket_name}")
        logger.info(f"Configuration:")
        logger.info(f"  Target file size: {TARGET_SIZE_MB} MB")
        logger.info(f"  Minimum files to combine: {MIN_FILES_TO_COMBINE}")

        # Test S3 connection first
        try:
            # Try to get bucket location to verify access
            response = self.s3_client.get_bucket_location(Bucket=self.bucket_name)
            logger.info(f"Successfully connected to bucket (region: {response.get('LocationConstraint', 'us-east-1')})")
        except ClientError as e:
            logger.error(f"Failed to access bucket '{self.bucket_name}': {e}")
            logger.error("Please verify:")
            logger.error("  1. Bucket name is correct")
            logger.error("  2. AWS credentials are configured")
            logger.error("  3. You have s3:GetBucketLocation permission")
            return

        # List all parquet files by table
        tables = self.list_parquet_files_by_table()

        if not tables:
            logger.warning("No tables with parquet files found")
            logger.info("Troubleshooting tips:")
            logger.info("  1. Verify the prefix path is correct")
            logger.info("  2. Check that parquet files exist in the expected structure")
            logger.info("  3. Ensure files have .parquet extension (case-insensitive)")
            return

        logger.info(f"Found {len(tables)} tables to process")

        # Process each table
        for table_name, files in tables.items():
            try:
                self.process_table(table_name, files)
            except Exception as e:
                logger.error(f"Error processing table {table_name}: {e}")
                continue

        logger.info("Parquet file combination completed")


def main():
    """Main function - Configure your S3 bucket and prefix here"""

    parser = argparse.ArgumentParser(description='Combine small Parquet files in S3 into larger files')
    parser.add_argument('--bucket', required=True, help='S3 bucket name')
    parser.add_argument('--prefix', required=True, help='Source data prefix')

    args = parser.parse_args()

    logger.info(f"Configuration:")
    logger.info(f"  Bucket: {args.bucket}")
    logger.info(f"  Prefix: {args.prefix}")
    logger.info(f"  Target file size: {TARGET_SIZE_MB} MB")
    logger.info(f"  Minimum files to combine: {MIN_FILES_TO_COMBINE}")

    # Initialize and run combiner
    combiner = S3ParquetCombiner(args.bucket, args.prefix)
    combiner.run()


if __name__ == "__main__":
    main()