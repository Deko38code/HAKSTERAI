# Amazon Q Developer CLI — Top Secrets & Best Practices

## Sources
- https://dev.to/aws-heroes/10-ways-i-use-the-amazon-q-developer-cli-to-save-time-88m
- Firecrawl search results

## What is Amazon Q Developer CLI?
AWS's AI coding agent for the terminal. Context-aware AWS expert + general coding assistant. Integrates with AWS services, CloudFormation, IAM, and more.

## Key Secrets

### 1. AWS Context Awareness
- Q CLI understands AWS services natively
- Ask about CloudFormation, IAM, EC2, S3, Lambda — it knows
- Can generate architecture diagrams from CloudFormation templates
- Best practice guidance for AWS services built-in
- Example: "explain best practices for setting request body parameters for models"

### 2. Context Management (/context)
- `/context add <file>` — Add file to context
- `/context show` — See what's in context
- `/context clear` — Clear context
- Q maintains context across the session
- Add relevant files before asking questions

### 3. Profile System
- `q --profile <name>` — Use specific AWS profile
- Different profiles for different AWS accounts
- Q respects AWS credentials and permissions
- Can work with multiple accounts in one session

### 4. Tool Use
- Q can execute AWS CLI commands
- Can create resources, query services, manage infrastructure
- Asks before executing — safety system
- Example: "list all S3 buckets in this account"

### 5. Conversation History
- `q --conversation <id>` — Resume conversation
- `q --list-conversations` — See past conversations
- Conversations saved locally
- Great for returning to complex tasks

### 6. Inline Chat
- `q chat "question"` — Quick one-off question
- No need to enter interactive mode
- Great for quick lookups
- Output goes to stdout — pipeable

### 7. Trust Mode
- `q --trust-all-tools` — Auto-approve all tool use
- `q --trust-tools <list>` — Approve specific tools
- Default: ask before each tool use
- Use trust mode for CI/CD automation

### 8. 10 Ways to Save Time (from dev.to)
1. **Architecture diagrams** — Generate from CloudFormation in seconds
2. **Best practice guidance** — Ask about AWS service best practices
3. **Code generation** — Generate Lambda functions, CDK code
4. **Debugging** — Paste error logs, Q explains and fixes
5. **IAM policy help** — Generate least-privilege policies
6. **Resource discovery** — "What resources are in this VPC?"
7. **Cost optimization** — "How can I reduce my EC2 costs?"
8. **Security review** — "Review this security group for issues"
9. **Migration help** — "How do I migrate from EC2 to Fargate?"
10. **Documentation** — Generate docs from infrastructure

### 9. IDE Integration
- Works alongside VS Code extension
- CLI and IDE share context
- Start in CLI, continue in IDE
- Seamless workflow between terminal and editor

### 10. Local Context Files
- Q reads `.qignore` — like .gitignore for Q
- Q reads project context files for guidance
- Configure in `~/.q/config.yaml`
- Set default profile, model preferences, trust settings

## Best Practices
- Use `/context add` before asking about specific files
- Use profiles for different AWS accounts
- Review tool execution before approving
- Use `--trust-all-tools` only in CI/CD, not dev
- Generate architecture diagrams from CloudFormation
- Ask for least-privilege IAM policies
- Use conversation history for complex multi-step tasks

## Amazon Q vs Others
| Feature | Amazon Q | Claude Code | Aider |
|---------|----------|-------------|-------|
| AWS Native | ✅ | ❌ | ❌ |
| Context | /context | CLAUDE.md | /add |
| Profiles | ✅ AWS | ❌ | ❌ |
| Tool Use | ✅ AWS CLI | Shell | Git |
| Conversations | ✅ Saved | ❌ | /save |
| Open Source | ❌ | ❌ | ✅ |
| Cost | AWS subscription | API costs | API costs |