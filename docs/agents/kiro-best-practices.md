# Kiro Best Practices Boilerplate

A comprehensive collection of steering documents and agent hooks for Kiro IDE that enforces development best practices, automates quality checks, and streamlines workflows.

## 🚀 Quick Start

### Option 1: Clone as Template
```bash
# Clone this repository as a template for your new project
git clone https://github.com/awsdataarchitect/kiro-best-practices.git your-project-name
cd your-project-name
rm -rf .git
git init
git add .
git commit -m "feat: initialize project with Kiro best practices"
```

### Option 2: Add to Existing Project (Recommended)
```bash
# Add only the .kiro directory to existing project
cd your-existing-project
mkdir -p .kiro && curl -L https://github.com/awsdataarchitect/kiro-best-practices/archive/main.tar.gz | tar -xz --strip-components=2 -C .kiro kiro-best-practices-main/.kiro
```

### Option 3: Manual Download
```bash
# Download and extract only .kiro directory
cd your-project
mkdir -p .kiro
curl -L https://github.com/awsdataarchitect/kiro-best-practices/archive/main.tar.gz | tar -xz --strip-components=2 -C .kiro kiro-best-practices-main/.kiro

# Or use git sparse-checkout for updates
git clone --filter=blob:none --sparse https://github.com/awsdataarchitect/kiro-best-practices.git temp-kiro
cd temp-kiro
git sparse-checkout set .kiro
cp -r .kiro/* ../.kiro/
cd .. && rm -rf temp-kiro
```

## ⚠️ Important: Activation Requirements

After installation:

- **🎯 Steering Documents**: Automatically refresh and become active immediately - no restart needed
- **🔄 Hooks**: Require **restarting Kiro** or **reopening the project** to become active

💡 **Tip**: After installation, restart Kiro to ensure all hooks are properly loaded and functional.

## 📋 What's Included

### 🎯 Steering Documents (Always Active)
Automatically guide all AI interactions with established best practices:

- **[AWS CLI Best Practices](.kiro/steering/aws-cli-best-practices.md)** - `--no-cli-pager` and AWS integration patterns
- **[CDK Best Practices](.kiro/steering/cdk-best-practices.md)** - Project structure, testing, and deployment patterns
- **[Development Standards](.kiro/steering/development-standards.md)** - Dependency management, code quality, documentation
- **[Docker Best Practices](.kiro/steering/docker-best-practices.md)** - Container security and optimization
- **[Git Best Practices](.kiro/steering/git-best-practices.md)** - Conventional commits, branching, and security
- **[MCP Best Practices](.kiro/steering/mcp-best-practices.md)** - Model Context Protocol server configuration and usage
- **[Python Best Practices](.kiro/steering/python-best-practices.md)** - Code style, virtual environments, and testing
- **[React Best Practices](.kiro/steering/react-best-practices.md)** - Component patterns, hooks, and accessibility
- **[Security Best Practices](.kiro/steering/security-best-practices.md)** - Code security, dependency management, data protection
- **[Testing Best Practices](.kiro/steering/testing-best-practices.md)** - Minimal verbosity, output management, performance
- **[TypeScript Best Practices](.kiro/steering/typescript-best-practices.md)** - Code style, type safety, and testing guidelines

### 🔄 Automatic Hooks (File Save Triggers)
Quality checks that run automatically when you save files:

- **[Auto Test on Save](.kiro/hooks/auto-test-on-save.kiro.hook)** - Runs tests with minimal verbosity when code changes
- **[Lint and Format on Save](.kiro/hooks/lint-and-format-on-save.kiro.hook)** - Auto-formats and lints code following project standards
- **[Security Scan on Dependencies](.kiro/hooks/security-scan-on-dependency-change.kiro.hook)** - Audits when package files change
- **[CDK Synth on Change](.kiro/hooks/cdk-synth-on-change.kiro.hook)** - Validates CDK code and runs synthesis
- **[Validate Docker on Change](.kiro/hooks/validate-docker-on-change.kiro.hook)** - Checks Docker files for best practices and security
- **[MCP Config Validation](.kiro/hooks/mcp-config-validation.kiro.hook)** - Validates MCP server configurations
- **[Environment File Validation](.kiro/hooks/env-file-validation.kiro.hook)** - Checks .env files for security issues
- **[API Schema Validation](.kiro/hooks/api-schema-validation.kiro.hook)** - Validates OpenAPI/GraphQL schemas and generates types

### 🔘 Manual Hooks (Button Triggers)
On-demand tools available in the Kiro Agent Hooks panel:

- **[Commit Message Helper](.kiro/hooks/commit-message-helper.kiro.hook)** - Creates conventional commit messages
- **[README Spell Check](.kiro/hooks/readme-spell-check.kiro.hook)** - Fixes spelling and grammar in documentation
- **[MCP Server Test](.kiro/hooks/mcp-server-test.kiro.hook)** - Tests all configured MCP servers
- **[Dependency Update Check](.kiro/hooks/dependency-update-check.kiro.hook)** - Finds outdated packages and security issues
- **[Code Coverage Check](.kiro/hooks/code-coverage-check.kiro.hook)** - Analyzes test coverage gaps
- **[Performance Analysis](.kiro/hooks/performance-analysis.kiro.hook)** - Identifies optimization opportunities

### 🎛️ Optional Hooks (Disabled by Default)
Performance-sensitive hooks you can enable as needed:

- **[Accessibility Audit](.kiro/hooks/accessibility-audit.kiro.hook)** - Checks React components for accessibility issues
- **[Update Documentation](.kiro/hooks/update-documentation.kiro.hook)** - Updates docs when code changes
- **[Translation Update](.kiro/hooks/translation-update.kiro.hook)** - Syncs translation files

## ⚙️ Configuration

### Enabling/Disabling Hooks
Edit any `.kiro.hook` file and change the `enabled` field:
```json
{
  "enabled": true,  // Change to false to disable
  "name": "Hook Name",
  // ... rest of configuration
}
```

### Customizing File Patterns
Modify the `patterns` array in hook files to match your project structure:
```json
{
  "when": {
    "type": "fileEdited",
    "patterns": [
      "src/**/*.ts",     // Your source files
      "lib/**/*.js",     // Your library files
      "**/*.custom"      // Your custom extensions
    ]
  }
}
```

### Adding Project-Specific Steering
Create additional steering documents in `.kiro/steering/`:
```markdown
---
title: Your Team Standards
inclusion: always
---

# Your Team-Specific Guidelines
- Team-specific coding standards
- Project-specific patterns
- Custom workflows
```

## 🛠️ Technology Support

This boilerplate includes best practices for:

- **Languages**: TypeScript, JavaScript, Python
- **Frameworks**: React, CDK, Docker
- **Tools**: Git, npm/yarn, pytest, ESLint, Prettier
- **Cloud**: AWS (CLI, CDK, services)
- **APIs**: OpenAPI/Swagger, GraphQL
- **Testing**: Jest, pytest, coverage analysis
- **Documentation**: Markdown, JSDoc, docstrings

## 📚 MCP Integration

Includes best practices for Model Context Protocol servers:

- **Context7** - For dependency compatibility checking
- **AWS Knowledge** - For current AWS documentation and best practices
- **AWS API** - For programmatic AWS interactions
- Proper configuration patterns and testing workflows

## 🔒 Security Features

Built-in security practices:

- Dependency vulnerability scanning
- Environment file validation (no secrets in code)
- Docker security best practices
- AWS security patterns
- MCP server security configurations

## 🎨 Customization Guide

### For Your Team
1. **Review all steering documents** - Modify for your team's standards
2. **Adjust hook sensitivity** - Enable/disable based on your workflow
3. **Update file patterns** - Match your project structure
4. **Add team-specific hooks** - Create custom automation for your needs

### For Your Project Type
- **Web Applications**: Enable accessibility audit, focus on React patterns
- **Infrastructure**: Enable CDK hooks, focus on AWS patterns
- **Libraries**: Enable documentation updates, focus on API patterns
- **Microservices**: Enable Docker validation, focus on testing patterns

## 📖 Documentation

- [Steering Documents](.kiro/steering/) - Individual best practice guides
- [Hook Configurations](.kiro/hooks/) - All available automation hooks

## 🤝 Contributing

### Adding New Best Practices
1. Create steering document in `.kiro/steering/`
2. Add corresponding hook in `.kiro/hooks/`
3. Update documentation
4. Test with sample project

### Sharing Improvements
1. Fork this repository
2. Add your improvements
3. Submit pull request with description
4. Include examples of usage

## 📄 License

MIT License - Feel free to use this in your projects and modify as needed.

## 🙋‍♂️ Support

- **Issues**: Report bugs or request features via GitHub issues
- **Discussions**: Share your customizations and ask questions
- **Wiki**: Community-contributed examples and patterns

---

## 🎯 Quick Verification

After setup, verify everything works:

1. **Check Steering**: AI responses should reference best practices
2. **Test Hooks**: Save a TypeScript file to trigger auto-test hook
3. **Manual Hooks**: Look for buttons in Kiro Agent Hooks panel
4. **MCP Integration**: Test MCP servers if configured

**Happy coding with consistent, high-quality development practices!** 🚀