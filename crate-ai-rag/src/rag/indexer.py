import os
import hashlib
import json
from pathlib import Path
from typing import List, Dict
import chromadb
from chromadb.config import Settings
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.document_loaders import UnstructuredMarkdownLoader
from sentence_transformers import SentenceTransformer
import yaml

class DocumentIndexer:
    def __init__(self, config_path: str = "config.yaml"):
        with open(config_path, 'r') as f:
            self.config = yaml.safe_load(f)
        
        # Initialize embedding model
        self.embedder = SentenceTransformer(
            self.config['embedding_model'],
            device='cpu'  # Use CUDA if available
        )
        
        # Initialize ChromaDB client
        self.client = chromadb.PersistentClient(
            path=self.config['vector_db']['persist_directory'],
            settings=Settings(
                anonymized_telemetry=False,
                allow_reset=True
            )
        )
        
        # Get or create collection
        self.collection = self.client.get_or_create_collection(
            name=self.config['vector_db']['collection_name'],
            metadata={"hnsw:space": "cosine"}
        )
        
        # Text splitter
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=self.config['chunking']['chunk_size'],
            chunk_overlap=self.config['chunking']['chunk_overlap'],
            separators=["\n\n", "\n", " ", ""]
        )
        
        # Cache for document hashes
        self.cache_file = Path("data/vector_db/.doc_cache.json")
        self.doc_cache = self._load_cache()
    
    def _load_cache(self) -> Dict:
        """Load document hash cache"""
        if self.cache_file.exists():
            with open(self.cache_file, 'r') as f:
                return json.load(f)
        return {}
    
    def _save_cache(self):
        """Save document hash cache"""
        self.cache_file.parent.mkdir(parents=True, exist_ok=True)
        with open(self.cache_file, 'w') as f:
            json.dump(self.doc_cache, f)
    
    def _compute_hash(self, content: str) -> str:
        """Compute MD5 hash of content"""
        return hashlib.md5(content.encode()).hexdigest()
    
    def _extract_dataset_info(self, file_path: Path) -> Dict:
        """Extract dataset information from file path and content"""
        # Assume dataset name is in the filename or parent directory
        dataset_name = file_path.stem
        if file_path.parent.name != "docs":
            dataset_name = f"{file_path.parent.name}/{dataset_name}"
        
        return {
            "dataset": dataset_name,
            "type": "schema" if "schema" in str(file_path).lower() else "documentation",
            "source": str(file_path)
        }
    
    def index_documents(self, doc_paths: List[str], force_reindex: bool = False):
        """Index markdown documents into vector database"""
        all_chunks = []
        all_metadatas = []
        all_ids = []
        
        for doc_path in doc_paths:
            path = Path(doc_path)
            
            # Process all markdown files
            md_files = list(path.glob("**/*.md"))
            print(f"Found {len(md_files)} markdown files in {doc_path}")
            
            for md_file in md_files:
                # Read file content
                with open(md_file, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                # Check if document has changed
                content_hash = self._compute_hash(content)
                if not force_reindex and str(md_file) in self.doc_cache:
                    if self.doc_cache[str(md_file)] == content_hash:
                        print(f"Skipping unchanged: {md_file}")
                        continue
                
                print(f"Processing: {md_file}")
                
                # Extract metadata
                base_metadata = self._extract_dataset_info(md_file)
                
                # Split into chunks
                chunks = self.text_splitter.split_text(content)
                
                # Prepare data for indexing
                for i, chunk in enumerate(chunks):
                    chunk_id = f"{md_file}_{i}"
                    metadata = {
                        **base_metadata,
                        "chunk_index": i,
                        "total_chunks": len(chunks)
                    }
                    
                    all_chunks.append(chunk)
                    all_metadatas.append(metadata)
                    all_ids.append(chunk_id)
                
                # Update cache
                self.doc_cache[str(md_file)] = content_hash
        
        # Index all chunks at once
        if all_chunks:
            print(f"Generating embeddings for {len(all_chunks)} chunks...")
            embeddings = self.embedder.encode(
                all_chunks,
                show_progress_bar=True,
                batch_size=32
            )
            
            # Add to ChromaDB
            self.collection.add(
                embeddings=embeddings.tolist(),
                documents=all_chunks,
                metadatas=all_metadatas,
                ids=all_ids
            )
            
            print(f"Successfully indexed {len(all_chunks)} chunks")
            
            # Save cache
            self._save_cache()
        else:
            print("No new documents to index")