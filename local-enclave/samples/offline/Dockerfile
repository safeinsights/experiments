# The smallest research container that exercises the whole enclave loop, with no registry or data
# access: python:3.12-slim plus a stdlib-only script. Built by `pnpm dev:enclave up`.
FROM python:3.12-slim
ARG SAMPLE_FAIL=0
ENV SAMPLE_FAIL=${SAMPLE_FAIL}
WORKDIR /app
COPY main.py .
CMD ["python", "main.py"]
