from typing import List, Dict, Optional
import chromadb
from sentence_transformers import SentenceTransformer
import yaml

class ContextRetriever:
    def __init__(self, config_path: str = "config.yaml"):
        with open(config_path, 'r') as f:
            self.config = yaml.safe_load(f)
        
        # Initialize embedding model
        self.embedder = SentenceTransformer(
            self.config['embedding_model'],
            device='cpu'
        )
        
        # Initialize ChromaDB client
        self.client = chromadb.PersistentClient(
            path=self.config['vector_db']['persist_directory']
        )
        
        self.collection = self.client.get_collection(
            name=self.config['vector_db']['collection_name']
        )
    
    def retrieve(
        self,
        query: str,
        dataset: Optional[str] = None,
        n_results: int = 5
    ) -> List[Dict]:
        """Retrieve relevant context for a query"""
        
        # Generate query embedding
        query_embedding = self.embedder.encode(query)
        
        # Build where clause for filtering by dataset
        where_clause = None
        if dataset:
            where_clause = {"dataset": {"$eq": dataset}}
        
        # Query the collection
        results = self.collection.query(
            query_embeddings=[query_embedding.tolist()],
            n_results=n_results,
            where=where_clause
        )
        
        # Format results
        contexts = []
        if results['documents']:
            for i in range(len(results['documents'][0])):
                contexts.append({
                    'text': results['documents'][0][i],
                    'metadata': results['metadatas'][0][i],
                    'distance': results['distances'][0][i]
                })
        
        return contexts
    
    def get_available_datasets(self) -> List[str]:
        """Get list of available datasets"""
        # Get all documents metadata
        all_data = self.collection.get()
        
        # Extract unique datasets
        datasets = set()
        for metadata in all_data['metadatas']:
            if 'dataset' in metadata:
                datasets.add(metadata['dataset'])
        
        return sorted(list(datasets))