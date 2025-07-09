FROM python:3.10-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    git \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create data directories
RUN mkdir -p data/vector_db models

# Download model at build time (optional, can be done at runtime)
# RUN python -c "from huggingface_hub import hf_hub_download; \
#     hf_hub_download('TheBloke/Mistral-7B-Instruct-v0.2-GGUF', \
#     'mistral-7b-instruct-v0.2.Q4_K_M.gguf', cache_dir='./models')"

# Expose port
EXPOSE 8000

# Run the application
CMD ["python", "-m", "uvicorn", "src.app:app", "--host", "0.0.0.0", "--port", "8000"]