# Research Code Generation API

A RAG (Retrieval-Augmented Generation) powered API that generates R code for research questions using contextual documentation and LLM capabilities.

## Overview

This application indexes research documentation and R library information into a vector database, then uses semantic search and language models to generate contextually relevant R code based on user queries.

### Key Features

- **Semantic Search**: Uses ChromaDB and sentence transformers for document retrieval
- **Code Generation**: Leverages Mistral-7B model via llama.cpp for R code generation
- **FastAPI Backend**: RESTful API with automatic documentation
- **Docker Support**: Containerized deployment for production
- **Caching**: Intelligent document indexing with MD5 hash-based caching

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   User Query    │───▶│  Context        │───▶│  Code           │
│                 │    │  Retrieval      │    │  Generation     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │                        │
                              ▼                        ▼
                    ┌─────────────────┐    ┌─────────────────┐
                    │  Vector DB      │    │  Mistral-7B     │
                    │  (ChromaDB)     │    │  (llama.cpp)    │
                    └─────────────────┘    └─────────────────┘
```

## Local Development

### Prerequisites

- Python 3.10+
- Git
- 8GB+ RAM (for LLM model)
- CUDA-compatible GPU (optional, for acceleration)

### Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd crate-ai-rag
   ```

2. **Create virtual environment**
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```
   
   **Note**: If you encounter issues with torch installation, try:
   ```bash
   # For CPU-only PyTorch (faster install)
   pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
   
   # Then install other requirements
   pip install -r requirements.txt
   ```

4. **Prepare sample data**
   ```bash
   # Create sample documentation files
   mkdir -p data/docs data/libraries
   
   # Add your markdown documentation files to:
   # - data/docs/        (dataset documentation)
   # - data/libraries/   (R library documentation)
   ```

5. **Index documents**
   ```bash
   python scripts/index_documents.py
   ```

6. **Start the development server**
   ```bash
   python src/app.py
   ```

   The API will be available at `http://localhost:8000`

### Configuration

Edit `config.yaml` to customize:

```yaml
# Model settings
embedding_model: "sentence-transformers/all-MiniLM-L6-v2"
llm_model: "TheBloke/Mistral-7B-Instruct-v0.2-GGUF"
llm_file: "mistral-7b-instruct-v0.2.Q4_K_M.gguf"

# Vector database
vector_db:
  type: "chroma"
  persist_directory: "./data/vector_db"
  collection_name: "research_docs"

# Document processing
chunking:
  chunk_size: 1000
  chunk_overlap: 200

# API settings
api:
  host: "0.0.0.0"
  port: 8000
```

### Development Commands

```bash
# Reindex all documents (force refresh)
python scripts/index_documents.py --force

# Index specific directories
python scripts/index_documents.py --paths data/docs data/custom_docs

# Start with custom host/port
python -m uvicorn src.app:app --host 0.0.0.0 --port 8001 --reload

# View API documentation
# Open http://localhost:8000/docs in your browser
```

## Production Deployment

### Docker Deployment

1. **Build the Docker image**
   ```bash
   docker build -t research-code-api .
   ```

2. **Run with Docker Compose**
   ```bash
   docker-compose up -d
   ```

3. **Scale the service**
   ```bash
   docker-compose up --scale api=3
   ```

### Docker Compose Configuration

Create or update `infrastructure/docker-compose.yml`:

```yaml
version: '3.8'

services:
  api:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - ./data:/app/data
      - ./models:/app/models
    environment:
      - PYTHONPATH=/app
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 8G
        reservations:
          memory: 4G

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
    depends_on:
      - api
    restart: unless-stopped
```

### AWS Deployment

1. **Configure AWS CLI**
   ```bash
   aws configure
   ```

2. **Create ECR repository**
   ```bash
   aws ecr create-repository --repository-name research-code-assistant
   ```

3. **Build and push Docker image**
   ```bash
   # Get login token
   aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com

   # Build and tag
   docker build -t research-code-assistant .
   docker tag research-code-assistant:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/research-code-assistant:latest

   # Push
   docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/research-code-assistant:latest
   ```

4. **Deploy with ECS/Fargate**
   ```bash
   # Use the Terraform configuration in infrastructure/terraform/
   cd infrastructure/terraform
   terraform init
   terraform plan
   terraform apply
   ```

### Environment Variables

For production deployment, set these environment variables:

```bash
# API Configuration
export API_HOST=0.0.0.0
export API_PORT=8000

# Model Configuration
export EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2
export LLM_MODEL=TheBloke/Mistral-7B-Instruct-v0.2-GGUF

# Database Configuration
export VECTOR_DB_PATH=/app/data/vector_db
export COLLECTION_NAME=research_docs

# Performance Settings
export CUDA_VISIBLE_DEVICES=0  # If using GPU
export OMP_NUM_THREADS=4
```

## API Usage

### Endpoints

- `GET /` - Health check
- `GET /datasets` - List available datasets
- `POST /generate` - Generate R code
- `POST /feedback` - Submit feedback

### Example Usage

```bash
# Generate R code
curl -X POST "http://localhost:8000/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "How do I calculate summary statistics for my dataset?",
    "dataset": "sample_data",
    "include_context": true,
    "max_results": 3
  }'

# List available datasets
curl "http://localhost:8000/datasets"
```

### Response Format

```json
{
  "code": "# Analysis for: How do I calculate summary statistics?\nlibrary(dplyr)\nsummary_stats <- data %>%\n  summarise(\n    mean_value = mean(column),\n    median_value = median(column),\n    sd_value = sd(column)\n  )\nprint(summary_stats)",
  "dataset": "sample_data",
  "timestamp": "2024-01-01T12:00:00Z",
  "context_sources": ["data/docs/sample_data.md"]
}
```

## Monitoring and Logging

### Health Checks

```bash
# API health
curl http://localhost:8000/

# Database status
curl http://localhost:8000/datasets
```

### Logs

```bash
# View application logs
docker-compose logs -f api

# View specific service logs
docker logs <container-id>
```

## Troubleshooting

### Common Issues

1. **Model download fails**
   ```bash
   # Manual model download
   python -c "from huggingface_hub import hf_hub_download; hf_hub_download('TheBloke/Mistral-7B-Instruct-v0.2-GGUF', 'mistral-7b-instruct-v0.2.Q4_K_M.gguf', cache_dir='./models')"
   ```

2. **Out of memory errors**
   ```bash
   # Reduce model size or use CPU-only mode
   # Edit config.yaml to use smaller model variant
   ```

3. **No documents indexed**
   ```bash
   # Check data directories
   ls -la data/docs/ data/libraries/
   
   # Force reindex
   python scripts/index_documents.py --force
   ```

4. **ChromaDB connection issues**
   ```bash
   # Reset vector database
   rm -rf data/vector_db/
   python scripts/index_documents.py
   ```

### Performance Optimization

1. **Enable GPU acceleration**
   ```bash
   # Install CUDA-enabled PyTorch
   pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
   ```

2. **Optimize chunking parameters**
   ```yaml
   chunking:
     chunk_size: 500  # Smaller chunks for better retrieval
     chunk_overlap: 100
   ```

3. **Increase batch size for indexing**
   ```python
   # In src/rag/indexer.py, increase batch_size
   embeddings = self.embedder.encode(
       all_chunks,
       batch_size=64  # Increase from 32
   )
   ```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.