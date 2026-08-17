# Qwen Coder — Top Secrets & Best Practices

## Sources
- https://github.com/QwenLM/Qwen3-Coder (402 lines saved locally as qwen-coder-readme.md)
- https://www.alibabacloud.com/blog/boost-your-coding-workflow-with-qwen-code-a-practical-guide_602991
- https://www.reddit.com/r/LocalLLaMA/comments/1n4mo1r/best_way_to_use_qwen3coder_for_local_ai_coding/
- https://github.com/AlongWY/Qwen2.5-Coder

## What is Qwen Coder?
Qwen Coder (Qwen3-Coder) is Alibaba's open-source coding model. Supports 358 coding languages. Can run locally via Ollama. Has both coding and agentic task capabilities. Available as CLI tool (`qwen` command).

## Key Secrets

### 1. Qwen Code CLI
- Install: `pip install qwen-code` or via Ollama
- Run: `qwen` in terminal — starts interactive coding session
- Similar to Claude Code CLI but powered by Qwen models
- Supports: file reading, code generation, multi-file editing

### 2. Local Deployment (Privacy-First)
- Run via Ollama: `ollama run qwen2.5-coder:7b` (or larger models)
- No data leaves your machine — full privacy
- Use with Cline/Continue/etc. as the backend model
- Models: 0.5B, 1.5B, 3B, 7B, 14B, 32B, 72B (size = capability)
- Quantized versions (Q4, Q5, Q8) for lower RAM requirements

### 3. Model Sizes & Use Cases
| Size | Use Case | RAM Needed (Q4) |
|------|----------|-----------------|
| 0.5B | Autocomplete, inline suggestions | ~1GB |
| 1.5B | Light coding, quick fixes | ~2GB |
| 3B | General coding assistance | ~4GB |
| 7B | Full coding tasks, multi-file | ~8GB |
| 14B | Complex refactoring, architecture | ~16GB |
| 32B | Advanced reasoning, large projects | ~32GB |
| 72B | Best quality, enterprise-grade | ~64GB+ |

### 4. Agentic Capabilities
- Qwen3-Coder supports agentic tasks (not just code completion)
- Can read/write files, execute commands
- Works with agent frameworks: Cline, Continue, OpenHands
- Tool calling support for function execution

### 5. Qwen Code Advanced Features
- **Repository understanding**: Point Qwen at a repo, it understands the codebase
- **Multi-language support**: 358 programming languages
- **Code repair**: Detect and fix bugs in existing code
- **Test generation**: Generate unit tests for existing functions
- **Doc generation**: Auto-generate documentation from code
- **Code translation**: Convert code between languages

### 6. Integration with Other Tools
- **Cline**: Use Qwen as the backend model for Cline in VS Code
- **Continue**: Use Qwen with Continue.dev for inline completion
- **Ollama**: Local deployment via Ollama API
- **vLLM**: High-throughput serving for teams
- **LM Studio**: GUI-based local deployment

### 7. Prompt Engineering for Qwen
- Be explicit about the language and framework
- Provide context files — Qwen works best with full context
- Use system prompts to set coding standards
- For agentic tasks: break into steps, provide clear instructions
- Qwen responds well to structured prompts (markdown, numbered lists)

### 8. Fine-Tuning
- Qwen Coder can be fine-tuned on your codebase
- Use QLoRA for efficient fine-tuning on consumer GPUs
- Fine-tune on your coding patterns for better suggestions
- Hugging Face transformers + PEFT for fine-tuning pipeline

### 9. Performance Tips (from Reddit)
- **7B is the sweet spot** for most coding tasks on consumer hardware
- **Q4 quantization** has minimal quality loss vs full precision
- **Context window**: Qwen3-Coder supports up to 256K tokens
- **FIM (Fill-In-the-Middle)**: Use FIM mode for autocomplete, not chat mode
- **Temperature 0.2-0.3** for code generation (low = more deterministic)
- **Use Devstral Small** as alternative autocomplete model

### 10. Qwen vs Commercial Models
- Qwen3-Coder 72B rivals Claude Sonnet on many coding benchmarks
- Qwen3-Coder 32B beats GPT-4 on several code generation tasks
- Free and open-source — no API costs
- Privacy: runs locally, no data sent to cloud
- Trade-off: requires local GPU/CPU resources

## Best Practices

### Local Setup
```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull Qwen Coder model
ollama pull qwen2.5-coder:7b

# Run interactive coding session
ollama run qwen2.5-coder:7b

# Or use with qwen-code CLI
pip install qwen-code
qwen
```

### With Cline
1. Install Cline in VS Code
2. Set provider to "Ollama" in Cline settings
3. Set model to `qwen2.5-coder:7b` (or larger)
4. Set base URL to `http://localhost:11434`
5. Create .clinerules for project context
6. Start coding with local AI

### With Continue.dev
1. Install Continue extension in VS Code
2. Configure `~/.continue/config.json`:
   ```json
   {
     "models": [{
       "title": "Qwen Coder",
       "provider": "ollama",
       "model": "qwen2.5-coder:7b"
     }]
   }
   ```
3. Use for inline completion and chat

## Qwen vs Claude Code vs Kiro vs Codex vs Cline
| Feature | Qwen Coder | Claude Code | Kiro | Codex CLI | Cline |
|---------|-----------|-------------|------|-----------|-------|
| Open Source | ✅ Apache 2.0 | ❌ | ❌ | ❌ | ✅ Apache 2.0 |
| Local Deploy | ✅ Ollama/vLLM | ❌ | ❌ | ❌ | ✅ via Ollama |
| Cost | Free | API costs | API costs | API costs | Free (local) |
| Privacy | Full | Cloud | Cloud | Cloud | Full (local) |
| Languages | 358 | All | All | All | All |
| Context | 256K tokens | 200K | Varies | Varies | Varies |
| Agentic | Yes | Yes | Yes | Yes | Yes |
| IDE | CLI + integrations | CLI | Full IDE | CLI | VS Code sidebar |