#!/bin/bash

# Performance test script for ccusage optimization
# This script demonstrates the performance improvement when using --since flag

echo "=== ccusage Performance Test ==="
echo
echo "This script will test the performance difference between:"
echo "1. Original version (from ryoppippi/ccusage)"
echo "2. Optimized version (from mbailey/ccusage#performance-optimization)"
echo
echo "Note: The first run may be slower due to package download."
echo "Run the script multiple times for accurate measurements."
echo
echo "Press Enter to continue..."
read

# Test date (adjust based on your usage data)
SINCE_DATE="20250618"

echo
echo "Testing with --since $SINCE_DATE"
echo

echo "1. Testing ORIGINAL version (ryoppippi/ccusage)..."
echo "   Command: npx github:ryoppippi/ccusage daily --since $SINCE_DATE"
echo "   Timing..."
time npx --yes github:ryoppippi/ccusage daily --since $SINCE_DATE > /dev/null 2>&1
ORIGINAL_TIME=$?

echo
echo "2. Testing OPTIMIZED version (mbailey/ccusage#performance-optimization)..."
echo "   Command: npx github:mbailey/ccusage#performance-optimization daily --since $SINCE_DATE"
echo "   Timing..."
time npx --yes github:mbailey/ccusage#performance-optimization daily --since $SINCE_DATE > /dev/null 2>&1
OPTIMIZED_TIME=$?

echo
echo "=== Results ==="
echo "The optimized version should be significantly faster (~17x improvement)."
echo
echo "To see the actual output (not just timing), run the commands without redirection:"
echo "  npx github:ryoppippi/ccusage daily --since $SINCE_DATE"
echo "  npx github:mbailey/ccusage#performance-optimization daily --since $SINCE_DATE"