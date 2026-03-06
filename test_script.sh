#!/bin/bash
echo "=== COMMAND 1 ==="
echo "which npx && npx --version && npm --version"
which npx && npx --version && npm --version
echo "Exit code: $?"

echo ""
echo "=== COMMAND 2 ==="
echo "npm install -g ts-complex"
npm install -g ts-complex
echo "Exit code: $?"

echo ""
echo "=== COMMAND 3 ==="
echo "ts-complex --version"
ts-complex --version
echo "Exit code: $?"

echo ""
echo "=== COMMAND 4 ==="
echo "ts-complex --help"
ts-complex --help
echo "Exit code: $?"
