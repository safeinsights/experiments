# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Research Code Generation API that uses RAG (Retrieval-Augmented Generation) to generate R code for research questions. The system indexes documentation into a vector database and uses LLMs to generate contextually relevant R code based on user queries.

## Development Commands

### Environment Setup
```bash
# Install dependencies
pip install -r requirements.txt

# Index documents into vector database
python scripts/index_documents.py

# Force reindex all documents
python scripts/index_documents.py --force
```

### Running the Application
```bash
# Start the API server
python src/app.py

# Or run with custom config
python -m uvicorn src.app:app --host 0.0.0.0 --port 8000 --reload
```

### Docker Deployment
```bash
# Build and run with Docker Compose
docker-compose up --build

# Run in detached mode
docker-compose up -d
```

## Architecture

### Core Components

1. **FastAPI Application** (`src/app.py`):
   - Main API server with endpoints for code generation
   - Handles CORS, logging, and request/response validation
   - Endpoints: `/generate` (POST), `/datasets` (GET), `/feedback` (POST)

2. **RAG Pipeline** (`src/rag/`):
   - **DocumentIndexer** (`indexer.py`): Indexes markdown documents into ChromaDB vector store
   - **ContextRetriever** (`retriever.py`): Retrieves relevant context using semantic search
   - **CodeGenerator** (`generator.py`): Generates R code using Llama model with context

3. **Data Models** (defined in `src/app.py`):
   - Pydantic models for request/response validation (CodeRequest, CodeResponse, DatasetResponse)

### Key Dependencies

- **LLM**: Uses Llama.cpp with Mistral-7B-Instruct model
- **Embeddings**: sentence-transformers/all-MiniLM-L6-v2
- **Vector Database**: ChromaDB with persistent storage
- **Text Processing**: LangChain for document chunking
- **API Framework**: FastAPI with uvicorn

### Configuration

Configuration is managed through `config.yaml`:
- Model settings (embedding model, LLM model)
- Vector database configuration
- Document chunking parameters
- API settings
- AWS deployment settings

### Document Processing

The system expects markdown documentation in:
- `data/docs/` - Dataset documentation
- `data/libraries/` - R library documentation

Documents are chunked using RecursiveCharacterTextSplitter with:
- Chunk size: 1000 characters
- Overlap: 200 characters
- Caching based on MD5 hashes to avoid reprocessing

### Code Generation Flow

1. User submits research question and dataset name
2. System retrieves relevant context from vector database
3. Context is formatted into prompt template
4. Llama model generates R code with explanations
5. Response includes generated code and optional context sources

## Common Patterns

### Error Handling
- HTTPException for API errors with proper status codes
- Comprehensive logging throughout the application
- Background tasks for non-blocking operations (feedback)

### Vector Database Operations
- Persistent ChromaDB client with cosine similarity
- Metadata filtering by dataset name
- Batch processing for efficient indexing

### Model Integration
- GPU acceleration when available (CUDA)
- Configurable context window and generation parameters
- Temperature settings optimized for code generation (0.3)