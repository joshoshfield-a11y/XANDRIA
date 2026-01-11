# Security Policy

## Supported Versions

We actively support the following versions with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 3.0.x   | :white_check_mark: |
| < 3.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in XANDRIA, please report it to us as follows:

### Contact Information
- **Primary Contact**: joshoshfield-a11y
- **GitHub Issues**: [Create a private security advisory](https://github.com/joshoshfield-a11y/XANDRIA/security/advisories/new)
- **Email**: Security reports can be sent to the repository maintainer

### What to Include
When reporting a security vulnerability, please include:
- A clear description of the vulnerability
- Steps to reproduce the issue
- Potential impact and severity assessment
- Any suggested fixes or mitigations

### Response Timeline
- **Initial Response**: Within 48 hours of receiving the report
- **Vulnerability Assessment**: Within 7 days
- **Fix Development**: Within 30 days for critical issues
- **Public Disclosure**: Coordinated with the reporter

### Responsible Disclosure
We kindly ask that you:
- Give us reasonable time to fix the issue before public disclosure
- Avoid accessing or modifying user data
- Keep the vulnerability details confidential until we publish a fix

## Security Best Practices

### For Contributors
- Never commit sensitive credentials, API keys, or certificates
- Use environment variables for configuration
- Run security scans before submitting pull requests
- Follow the principle of least privilege

### For Users
- Keep dependencies updated
- Use strong, unique passwords
- Enable two-factor authentication on GitHub
- Review and understand the commercial license terms

## Known Security Considerations

### Commercial Licensing
XANDRIA requires commercial licensing for commercial use. Unauthorized commercial use may expose organizations to legal and security risks.

### Dependency Security
We monitor third-party dependencies for known vulnerabilities. Critical security updates are prioritized.

### Cryptographic Practices
- All cryptographic operations follow industry best practices
- Keys and certificates are never stored in the repository
- Secure random number generation is used where required

## Security Updates

Security updates will be:
- Released as patch versions (e.g., 3.0.1, 3.0.2)
- Documented in release notes with CVE identifiers when applicable
- Communicated through GitHub releases and security advisories

## Questions

If you have questions about this security policy, please create an issue or contact the maintainers.