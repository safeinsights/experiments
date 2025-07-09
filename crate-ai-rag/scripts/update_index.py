#!/usr/bin/env python3
"""
Script to update the document index with new or modified files
Usage: python scripts/update_index.py [--watch] [--paths path1 path2 ...]
"""
import sys
import argparse
import time
import os
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# Add project root to path
sys.path.append(str(Path(__file__).parent.parent))

from src.rag.indexer import DocumentIndexer

class DocumentChangeHandler(FileSystemEventHandler):
    def __init__(self, indexer, paths):
        self.indexer = indexer
        self.paths = paths
        self.last_update = time.time()
        self.update_delay = 5  # Wait 5 seconds before updating to batch changes

    def on_modified(self, event):
        if event.is_directory:
            return
        
        # Only process markdown files
        if not event.src_path.endswith('.md'):
            return
        
        current_time = time.time()
        if current_time - self.last_update < self.update_delay:
            return
        
        print(f"Detected change in {event.src_path}")
        self.update_index()
        self.last_update = current_time

    def on_created(self, event):
        self.on_modified(event)

    def on_deleted(self, event):
        if event.is_directory:
            return
        
        if event.src_path.endswith('.md'):
            print(f"File deleted: {event.src_path}")
            print("Note: Deleted files are not automatically removed from the index.")
            print("Run with --force to rebuild the entire index.")

    def update_index(self):
        try:
            print("Updating document index...")
            self.indexer.index_documents(self.paths, force_reindex=False)
            print("Index updated successfully!")
        except Exception as e:
            print(f"Error updating index: {e}")

def main():
    parser = argparse.ArgumentParser(description="Update document index")
    parser.add_argument(
        "--watch",
        action="store_true",
        help="Watch for file changes and update index automatically"
    )
    parser.add_argument(
        "--paths",
        nargs="+",
        default=["data/docs", "data/libraries"],
        help="Paths to document directories"
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force reindex all documents"
    )
    
    args = parser.parse_args()
    
    # Validate paths
    valid_paths = []
    for path in args.paths:
        if os.path.exists(path):
            valid_paths.append(path)
        else:
            print(f"Warning: Path '{path}' does not exist, skipping...")
    
    if not valid_paths:
        print("No valid paths found. Exiting.")
        return
    
    # Initialize indexer
    print("Initializing document indexer...")
    indexer = DocumentIndexer()
    
    if args.watch:
        # Set up file watcher
        event_handler = DocumentChangeHandler(indexer, valid_paths)
        observer = Observer()
        
        for path in valid_paths:
            observer.schedule(event_handler, path, recursive=True)
            print(f"Watching {path} for changes...")
        
        observer.start()
        
        try:
            print("File watcher started. Press Ctrl+C to stop.")
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            observer.stop()
            print("\nFile watcher stopped.")
        
        observer.join()
    else:
        # One-time update
        print(f"Updating index for paths: {valid_paths}")
        indexer.index_documents(valid_paths, force_reindex=args.force)
        print("Index update complete!")

if __name__ == "__main__":
    main()