# Contributing to XANDRIA

Thank you for your interest in contributing to XANDRIA! This document provides guidelines and information for contributors.

## 📋 Table of Contents
- [Code of Conduct](#code-of-conduct)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Accessibility Guidelines](#accessibility-guidelines)
- [Submitting Changes](#submitting-changes)
- [Reporting Issues](#reporting-issues)

## 🤝 Code of Conduct

This project follows our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold this code. Please report any unacceptable behavior to the maintainers.

## 🚀 How to Contribute

### Types of Contributions
- **🐛 Bug fixes** - Fix issues and improve stability
- **✨ Features** - Add new functionality
- **📚 Documentation** - Improve docs, tutorials, or examples
- **🎨 UI/UX** - Enhance user interface and experience
- **♿ Accessibility** - Improve accessibility compliance
- **🧪 Testing** - Add or improve test coverage
- **🔧 Tooling** - Improve build tools, CI/CD, or development workflow

### Contribution Process
1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/your-username/XANDRIA.git`
3. **Create** a feature branch: `git checkout -b feature/your-feature-name`
4. **Make** your changes following our guidelines
5. **Test** thoroughly (see Testing section)
6. **Commit** with clear messages: `git commit -m "feat: add new operator"`
7. **Push** to your fork: `git push origin feature/your-feature-name`
8. **Create** a Pull Request

## 🛠️ Development Setup

### Prerequisites
- **Node.js**: >= 16.0.0 (preferably 18.x LTS)
- **npm**: >= 8.0.0
- **Git**: Latest version

### Installation
```bash
# Clone the repository
git clone https://github.com/joshoshfield-a11y/XANDRIA.git
cd XANDRIA

# Install dependencies
npm install

# Start development server
npm run dev
```

### Development Scripts
```bash
# Development
npm run dev          # Start development server
npm run build:dev    # Development build

# Testing
npm run test:all     # Run all tests
npm run test:unit    # Unit tests only
npm run test:a11y    # Accessibility tests

# Quality
npm run lint         # Lint code
npm run type-check   # TypeScript checking
npm run format       # Format code

# Production
npm run build        # Production build
npm run docs         # Generate documentation
```

## 📝 Coding Standards

### TypeScript/JavaScript
- **Strict TypeScript**: All code must pass strict type checking
- **ES Modules**: Use ES modules, not CommonJS
- **Async/Await**: Prefer async/await over Promises
- **Error Handling**: Proper try/catch blocks and error propagation

### Code Style
- **Prettier**: Code is automatically formatted
- **ESLint**: Follows configured linting rules
- **Consistent Naming**: camelCase for variables/functions, PascalCase for classes/types

### File Organization
```
src/
├── app/              # Application modules
├── core/             # Core engine components
├── graphics/         # Graphics and rendering
├── tests/           # Test files
└── types/           # TypeScript type definitions
```

## 🧪 Testing

### Test Requirements
- **Unit Tests**: All new functions/classes must have unit tests
- **Integration Tests**: Complex features need integration tests
- **Accessibility Tests**: UI components must pass a11y tests
- **Coverage**: Maintain >80% test coverage

### Running Tests
```bash
# All tests
npm run test:all

# Unit tests only
npm run test:unit

# Accessibility tests
npm run test:a11y

# With coverage
npm run test:coverage
```

### Test Structure
```typescript
describe('ComponentName', () => {
  it('should do something specific', () => {
    // Arrange
    const input = 'test input';

    // Act
    const result = someFunction(input);

    // Assert
    expect(result).toBe('expected output');
  });
});
```

## ♿ Accessibility Guidelines

XANDRIA is committed to accessibility. All contributions must:

### Web Content Accessibility Guidelines (WCAG 2.1 AA)
- **Perceivable**: Information must be presentable in ways users can perceive
- **Operable**: Interface components must be operable
- **Understandable**: Information and operation must be understandable
- **Robust**: Content must be robust enough for various user agents

### Implementation Requirements
- **Semantic HTML**: Use proper semantic elements
- **ARIA Labels**: Provide ARIA labels where needed
- **Keyboard Navigation**: All interactive elements must be keyboard accessible
- **Color Contrast**: Maintain WCAG AA contrast ratios (4.5:1 normal, 3:1 large)
- **Focus Management**: Proper focus indicators and management
- **Screen Reader Support**: Test with screen readers

### Testing Accessibility
```bash
# Run accessibility tests
npm run test:a11y

# Manual testing checklist:
# - [ ] Keyboard navigation works
# - [ ] Screen reader announces properly
# - [ ] Color contrast meets WCAG AA
# - [ ] Focus indicators are visible
# - [ ] No keyboard traps
```

### Accessibility Resources
- [WCAG 2.1 Guidelines](https://www.w3.org/TR/WCAG21/)
- [WebAIM](https://webaim.org/)
- [axe-core Documentation](https://github.com/dequelabs/axe-core)

## 📤 Submitting Changes

### Pull Request Process
1. **Update Documentation**: Update docs for any changed functionality
2. **Add Tests**: Ensure tests cover new/changed code
3. **Update CHANGELOG**: Add entry for user-facing changes
4. **Squash Commits**: Use clear, descriptive commit messages

### Commit Message Format
```
type(scope): description

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Code style changes
- `refactor`: Code refactoring
- `test`: Testing
- `chore`: Maintenance

**Examples:**
```
feat(generation): add new operator for physics simulation
fix(ui): resolve keyboard navigation in game editor
docs(api): update operator reference documentation
```

### Pull Request Template
Please use the provided PR template and ensure:
- [ ] Tests pass
- [ ] Code is linted and formatted
- [ ] Accessibility requirements met
- [ ] Documentation updated
- [ ] No breaking changes without discussion

## 🐛 Reporting Issues

### Bug Reports
Use the bug report template and include:
- **Clear Title**: Describe the issue concisely
- **Steps to Reproduce**: Numbered steps to reproduce
- **Expected Behavior**: What should happen
- **Actual Behavior**: What actually happens
- **Environment**: Browser, OS, Node version
- **Screenshots**: If applicable
- **Accessibility Impact**: Does this affect accessibility?

### Feature Requests
Use the feature request template and include:
- **Problem**: What's the problem this solves?
- **Solution**: How should it work?
- **Alternatives**: Other approaches considered?
- **Accessibility**: How does this impact accessibility?

### Security Issues
For security vulnerabilities:
- **DO NOT** create a public issue
- Email maintainers directly
- Include detailed reproduction steps

## 🎯 Recognition

Contributors are recognized in:
- **CHANGELOG.md**: For significant contributions
- **README.md**: Hall of Fame section
- **GitHub Contributors**: Automatic recognition

## 📞 Getting Help

- **Documentation**: Check [docs/](docs/) first
- **Issues**: Search existing issues before creating new ones
- **Discussions**: Use GitHub Discussions for questions
- **Discord**: Join our community Discord (link in README)

## 📄 License

By contributing, you agree that your contributions will be licensed under the same MIT License that covers the project.

---

**Thank you for contributing to XANDRIA! Your efforts help make AI-powered development more accessible and powerful for everyone. 🚀**