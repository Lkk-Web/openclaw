#!/bin/bash

# Clean completed session files
# Moves completed sessions to .deleted suffix

SESSION_DIR="$HOME/.openclaw/agents"
INACTIVE_THRESHOLD=3600  # 1 hour in seconds

echo "🧹 Cleaning completed session files..."

cleaned=0

for session_file in "$SESSION_DIR"/*/sessions/*.jsonl; do
  [ -f "$session_file" ] || continue
  
  # Check for 0s duration (abnormal sessions)
  if grep -q '"duration":[0-9]\{1,3\}\(,\|}\)' "$session_file" 2>/dev/null; then
    mv "$session_file" "${session_file}.deleted"
    echo "✓ Cleaned (0s duration): $(basename "$session_file")"
    ((cleaned++))
    continue
  fi
  
  # Check last line for completion markers
  last_line=$(tail -n 1 "$session_file" 2>/dev/null)
  
  if echo "$last_line" | grep -qE '"(completed|done|finished)"'; then
    mv "$session_file" "${session_file}.deleted"
    echo "✓ Cleaned: $(basename "$session_file")"
    ((cleaned++))
    continue
  fi
  
  # Check if file is inactive (>1 hour old)
  current_time=$(date +%s)
  file_time=$(stat -f %m "$session_file" 2>/dev/null || stat -c %Y "$session_file" 2>/dev/null)
  
  if [ -n "$file_time" ] && [ $((current_time - file_time)) -gt $INACTIVE_THRESHOLD ]; then
    mv "$session_file" "${session_file}.deleted"
    echo "✓ Cleaned (inactive): $(basename "$session_file")"
    ((cleaned++))
  fi
done

echo ""
echo "✅ Cleaned $cleaned session files"
