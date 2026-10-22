# Built by `pnpm dev:enclave up` for every "run your own code" job: the chosen base image, the
# pasted script as main.py, and runner.py which handles the trusted-output-app protocol.
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}
WORKDIR /job
COPY runner.py main.py /job/
CMD ["python", "/job/runner.py"]
