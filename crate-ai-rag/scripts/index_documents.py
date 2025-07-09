#!/usr/bin/env python3
"""
Script to index documentation into vector database
Usage: python scripts/index_documents.py [--force]
"""
import sys
import argparse
from pathlib import Path

# Add project root to path
sys.path.append(str(Path(__file__).parent.parent))

from src.rag.indexer import DocumentIndexer

def main():
    parser = argparse.ArgumentParser(description="Index documentation into vector database")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force reindex all documents"
    )
    parser.add_argument(
        "--paths",
        nargs="+",
        default=["data/docs", "data/r_libraries"],
        help="Paths to document directories"
    )
    
    args = parser.parse_args()
    
    # Initialize indexer
    print("Initializing document indexer...")
    indexer = DocumentIndexer()
    
    # Index documents
    print(f"Indexing documents from: {args.paths}")
    indexer.index_documents(args.paths, force_reindex=args.force)
    
    print("Indexing complete!")

if __name__ == "__main__":
    main()