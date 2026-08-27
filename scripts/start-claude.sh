#!/bin/bash
cd "$(dirname "$0")/.."
export MCP_CLIENT_NAME=claude
exec npm start
