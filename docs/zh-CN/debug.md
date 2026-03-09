1. node > 20

2. 运行

```sh
#npm install -g openclaw@latest

pnpm install

pnpm gateway:watch

pnpm openclaw setup # 设置本地.openclaw

openclaw dashboard # 设置token

```

3. 编辑 openclaw.json

```json
{
  "meta": {
    "lastTouchedVersion": "2026.3.8",
    "lastTouchedAt": "2026-03-09T05:51:55.748Z"
  },
  "models": {
    "mode": "merge",
    "providers": {
      "cass-gpt": {
        "baseUrl": "http://116.63.86.12:3000/v1",
        "apiKey": "sk-pmudckwSDsRNkE0bC49dDb57AcD043129434Cd1aC397296f",
        "api": "openai-completions",
        "models": [
          {
            "id": "gpt-5.2-chat",
            "name": "gpt-5.2-chat",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 200000,
            "maxTokens": 100000
          }
        ]
      },
      "cass-codex": {
        "baseUrl": "http://code.casstime.ai/v1",
        "apiKey": "sk-7QtSwsXxQz4lw7ewp4kEeSR3EVv5imFiCJ98ttJPScZ316S3",
        "api": "openai-responses",
        "models": [
          {
            "id": "gpt-5.3-codex",
            "name": "gpt-5.3-codex",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 200000,
            "maxTokens": 100000
          }
        ]
      },
      "cass-claude": {
        "baseUrl": "http://code.casstime.ai",
        "apiKey": "sk-7QtSwsXxQz4lw7ewp4kEeSR3EVv5imFiCJ98ttJPScZ316S3",
        "api": "anthropic-messages",
        "models": [
          {
            "id": "claude-sonnet-4-5-20250929",
            "name": "claude-sonnet-4-5-20250929",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 200000,
            "maxTokens": 100000
          },
          {
            "id": "claude-opus-4-6",
            "name": "claude-opus-4-6",
            "api": "anthropic-messages",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 200000,
            "maxTokens": 100000
          }
        ]
      },
      "zhipu": {
        "baseUrl": "https://open.bigmodel.cn/api/anthropic",
        "apiKey": "xxxxxxxxxxxxxxxxxxxxxxx",
        "api": "anthropic-messages",
        "models": [
          {
            "id": "glm-4.7",
            "name": "GLM-4.7",
            "reasoning": false,
            "input": ["text"],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 200000,
            "maxTokens": 100000
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "cass-claude/claude-opus-4-6"
      },
      "models": {
        "cass-gpt/gpt-5.2-chat": {},
        "cass-codex/gpt-5.3-codex": {},
        "cass-claude/claude-opus-4-6": {},
        "cass-claude/claude-sonnet-4-5-20250929": {},
        "zhipu/glm-4.7": {}
      },
      "workspace": "/Users/max/.openclaw/workspace",
      "compaction": {
        "mode": "safeguard"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8
      }
    }
  },
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": true,
    "ownerDisplay": "raw"
  },
  "gateway": {
    "mode": "local",
    "auth": {
      "mode": "token",
      "token": "55127c69a9a907519d7113b5c566518910564f6d869ea42e"
    }
  }
}
```
