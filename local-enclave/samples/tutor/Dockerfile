# The shape the containerizer builds for a real study: the member's base image, the researcher's
# code copied into its WORKDIR (/ for openstax/python-base), and the code environment's command.
# BASE_IMAGE is a harbor.safeinsights.org/openstax/python-base tag, which needs a Harbor login.
ARG BASE_IMAGE=harbor.safeinsights.org/openstax/python-base:3.12-2026-10-01-ed858d81
FROM ${BASE_IMAGE}
WORKDIR /
COPY main.py /main.py
CMD ["python", "main.py"]
