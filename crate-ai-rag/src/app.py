from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import uvicorn
import yaml
import logging
from datetime import datetime

from src.rag.retriever import ContextRetriever
from src.rag.generator import CodeGenerator

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load config
with open("config.yaml", 'r') as f:
    config = yaml.safe_load(f)

# Initialize components
app = FastAPI(
    title="Research Code Generation API",
    description="Generate R code for research questions using RAG",
    version="1.0.0"
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize RAG components
retriever = ContextRetriever()
generator = CodeGenerator()

# Request/Response models
class CodeRequest(BaseModel):
    question: str
    dataset: str
    include_context: bool = False
    max_results: int = 5

class CodeResponse(BaseModel):
    code: str
    dataset: str
    timestamp: str
    context_sources: Optional[List[str]] = None

class DatasetResponse(BaseModel):
    datasets: List[str]
    count: int

# Endpoints
@app.get("/", tags=["Health"])
async def root():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "Research Code Generation API",
        "timestamp": datetime.utcnow().isoformat()
    }

@app.get("/datasets", response_model=DatasetResponse, tags=["Datasets"])
async def list_datasets():
    """Get list of available datasets"""
    try:
        datasets = retriever.get_available_datasets()
        return DatasetResponse(
            datasets=datasets,
            count=len(datasets)
        )
    except Exception as e:
        logger.error(f"Error listing datasets: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/generate", response_model=CodeResponse, tags=["Generation"])
async def generate_code(request: CodeRequest):
    """Generate R code for a research question"""
    try:
        logger.info(f"Generating code for dataset: {request.dataset}")
        
        # Retrieve relevant context
        contexts = retriever.retrieve(
            query=request.question,
            dataset=request.dataset,
            n_results=request.max_results
        )
        
        if not contexts:
            raise HTTPException(
                status_code=404,
                detail=f"No documentation found for dataset: {request.dataset}"
            )
        
        # Generate code
        code = generator.generate(
            question=request.question,
            contexts=contexts,
            dataset=request.dataset
        )
        
        # Prepare response
        response = CodeResponse(
            code=code,
            dataset=request.dataset,
            timestamp=datetime.utcnow().isoformat()
        )
        
        # Include context sources if requested
        if request.include_context:
            response.context_sources = [
                ctx['metadata']['source'] for ctx in contexts
            ]
        
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error generating code: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/feedback", tags=["Feedback"])
async def submit_feedback(
    code_response: CodeResponse,
    feedback: str,
    background_tasks: BackgroundTasks
):
    """Submit feedback on generated code"""
    # Log feedback for future improvements
    background_tasks.add_task(
        log_feedback,
        code_response,
        feedback
    )
    return {"status": "Feedback received"}

def log_feedback(code_response: CodeResponse, feedback: str):
    """Log feedback for analysis"""
    logger.info(f"Feedback received for dataset {code_response.dataset}: {feedback}")

if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host=config['api']['host'],
        port=config['api']['port'],
        reload=True
    )