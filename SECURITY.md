# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public GitHub issue.**
2. Create a private security advisory: GitHub → Security → Advisories → New
3. Alternatively, email **security@fwmakc.dev** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (optional)

You will receive a response within **48 hours**. We will coordinate disclosure
timing and credit you in the advisory.

## Scope

| Area | In Scope |
|------|----------|
| Authentication | Bypasses, token forgery, session fixation |
| Authorization | Privilege escalation, broken access control |
| JWT | Signing flaws, key leakage, algorithm confusion |
| SQL | Injection via any input vector |
| Webhooks | SSRF in event delivery, webhook spoofing |
| Secrets | Hardcoded credentials, key exposure in source |

## Out of Scope

- Rate limiting / DoS
- Social engineering
- Issues in third-party dependencies (report upstream)
- Theoretical attacks without a working proof of concept

## Best Practices When Reporting

- Test against your own local instance, not production
- Do not access or modify other users' data
- Provide a minimal reproduction case
