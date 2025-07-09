from typing import List, Dict, Optional
import torch
from llama_cpp import Llama
from huggingface_hub import hf_hub_download
import yaml
import re

class CodeGenerator:
    def __init__(self, config_path: str = "config.yaml"):
        with open(config_path, 'r') as f:
            self.config = yaml.safe_load(f)
        
        # Download and load model
        model_path = hf_hub_download(
            repo_id=self.config['llm_model'],
            filename=self.config['llm_file'],
            cache_dir="./models"
        )
        
        # Initialize Llama model with GPU support if available
        self.llm = Llama(
            model_path=model_path,
            n_ctx=4096,  # Context window
            n_threads=4,
            n_gpu_layers=-1 if torch.cuda.is_available() else 0,
            verbose=False
        )
        
        # Prompt template
        self.prompt_template = """You are an expert R programmer helping researchers analyze their data. 
You have access to specific dataset schemas and R libraries.

IMPORTANT: Only use data fields and functions that are explicitly mentioned in the provided context.
Do not invent or assume any data fields or functions that are not documented.

Context about the dataset '{dataset}':
{context}

User's research question: {question}

Generate R code that:
1. Addresses the research question
2. Uses ONLY the documented data fields and functions
3. Includes comments explaining the approach
4. Handles potential errors gracefully

R Code:
```r
# Analysis for: {question}
"""
    
    def generate(
        self,
        question: str,
        contexts: List[Dict],
        dataset: str,
        max_tokens: int = 1024
    ) -> str:
        """Generate R code based on question and context"""
        
        # Combine contexts
        context_text = "\n\n".join([
            f"[From {ctx['metadata']['source']}]:\n{ctx['text']}"
            for ctx in contexts
        ])
        
        # Build prompt
        prompt = self.prompt_template.format(
            dataset=dataset,
            context=context_text,
            question=question
        )
        
        # Generate response
        response = self.llm(
            prompt,
            max_tokens=max_tokens,
            temperature=0.3,  # Lower temperature for more focused code
            stop=["```", "User:", "Question:"],
            echo=False
        )
        
        # Extract generated text
        generated_text = response['choices'][0]['text']
        
        # Clean up the response
        code = self._extract_code(generated_text)
        
        return code
    
    def _extract_code(self, text: str) -> str:
        """Extract clean R code from generated text"""
        # Remove any trailing explanation
        lines = text.split('\n')
        code_lines = []
        
        for line in lines:
            # Stop if we hit common end markers
            if any(marker in line.lower() for marker in ['note:', 'explanation:', 'this code']):
                break
            code_lines.append(line)
        
        # Join and clean
        code = '\n'.join(code_lines).strip()
        
        # Ensure it ends with a newline
        if code and not code.endswith('\n'):
            code += '\n'
        
        return code