# 👥 Contributing Guidelines

> Welcome to FaceRecogApp! Here's how to contribute.

---

## Code of Conduct

We are committed to providing a welcoming and inspiring community for all. Please respect others and maintain professional standards in all interactions.

---

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork**: `git clone https://github.com/YOUR_USERNAME/FaceRecogApp.git`
3. **Create a feature branch**: `git checkout -b feature/my-feature`
4. **Make your changes** (don't modify code unless fixing bugs)
5. **Commit with clear messages**: `git commit -m "Add feature: X"`
6. **Push to your fork**: `git push origin feature/my-feature`
7. **Open a Pull Request** against the main repository

---

## Development Workflow

### Branch Naming

- `feature/description` - for new features
- `bugfix/description` - for bug fixes
- `docs/description` - for documentation
- `refactor/description` - for code refactoring

### Commit Messages

Use clear, descriptive messages following this format:

```
[Type]: Brief description (50 chars max)

Detailed explanation of changes if needed.
Reference any related issues: Fixes #123
```

Types:

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `refactor`: Code refactoring
- `test`: Tests
- `chore`: Configuration, dependencies

### Code Style

**TypeScript/JavaScript**:

- Use ESLint and Prettier configs provided
- Run `npm run lint` before committing
- Run `npm run format` to auto-format code

**Commit Style**:

```bash
npm run lint      # Check style
npm run format    # Auto-fix style issues
npm run test      # Run tests
```

---

## Documentation

### README Changes

- Keep README.md concise and focused
- Update both README and relevant detailed docs
- Include examples where helpful

### Creating New Docs

- Use Markdown format
- Include table of contents for long docs
- Add code examples with language tags
- Link to related documentation

### Documentation Structure

```
Project Root
├── README.md           ← Overview & quick start
├── PROJECT.md          ← Project statement & scope
├── INSTALLATION.md     ← Setup instructions
├── ARCHITECTURE.md     ← Technical deep dive
├── CONTRIBUTING.md     ← This file
└── LICENSE             ← MIT License
```

---

## Testing

### Running Tests

```bash
npm test                    # Run all tests
npm test -- --watch        # Watch mode
npm test -- path/file.test # Specific test
```

### Writing Tests

- Place tests in `__tests__` directory
- Name files as `ComponentName.test.tsx`
- Use Jest + React Testing Library
- Aim for >80% code coverage

### Test Structure

```typescript
import { render, screen } from '@testing-library/react-native';
import MyComponent from './MyComponent';

describe('MyComponent', () => {
  it('should render correctly', () => {
    render(<MyComponent />);
    expect(screen.getByText('Hello')).toBeOnTheScreen();
  });
});
```

---

## Pull Request Process

### Before Submitting

1. **Update documentation** if you changed behavior
2. **Add tests** for new functionality
3. **Run full test suite**: `npm test`
4. **Run linting**: `npm run lint`
5. **Check performance** if touching inference code

### PR Description Template

```markdown
## Description

Brief description of changes

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Performance improvement

## Related Issues

Closes #123

## Testing

- [ ] Tested on Android
- [ ] Tested on iOS
- [ ] All tests passing
- [ ] Manual testing completed

## Checklist

- [ ] Code follows style guide
- [ ] Documentation updated
- [ ] No new warnings generated
- [ ] Tests added/updated
```

### Review Process

- Minimum 1 approval required
- CI checks must pass
- No conflicts with main branch
- Code review feedback must be addressed

---

## Reporting Issues

### Bug Reports

Include:

- **Device & OS**: Android/iOS, version
- **Steps to reproduce**: Clear steps
- **Expected behavior**: What should happen
- **Actual behavior**: What actually happens
- **Screenshots**: If applicable
- **Logs**: Error messages or stack traces

### Feature Requests

Include:

- **Use case**: Why is this needed?
- **Proposed solution**: Your idea
- **Alternatives**: Other approaches
- **Additional context**: Screenshots, mockups

---

## Development Tips

### Debugging

**React Native Debugging**:

```bash
# Enable React DevTools
npx react-native start --reset-cache

# Press 'i' for iOS or 'a' for Android debugger
```

**Model Debugging**:

- Check model loading in console
- Monitor inference time with performance markers
- Log embedding dimensions to verify output

### Performance Testing

```bash
# Profile app performance
npm run profile

# Check bundle size
npm run analyze-bundle

# Performance audit
npm run perf-audit
```

### Common Tasks

**Update dependencies**:

```bash
npm update
npm audit fix
```

**Clean build**:

```bash
npm run clean
npm install
npm run rebuild
```

**Reset emulator**:

```bash
# Android
emulator -avd <name> -wipe-data

# iOS
xcrun simctl erase all
```

---

## AI/ML Contributions

### Adding New ML Models

1. **Validate model**:
   - Test inference accuracy
   - Benchmark inference speed
   - Measure model size

2. **Optimize for mobile**:
   - Convert to TensorFlow Lite
   - Apply INT8 quantization
   - Target <5 MB size

3. **Document model**:
   - Model architecture
   - Input/output specifications
   - Performance characteristics
   - Training data (if applicable)

4. **Add model loading**:
   - Update model loader in code
   - Add version checking
   - Implement fallback to default model

---

## Documentation Contributions

### Updating README

- Keep it concise (<10 minute read)
- Use clear headers and structure
- Include badges for status
- Add relevant links

### Improving Architecture Docs

- Explain design decisions
- Include diagrams where helpful
- Document API surfaces
- Provide code examples

### Writing Tutorials

- Step-by-step instructions
- Include prerequisites
- Provide troubleshooting
- Link to related docs

---

## Submitting for Review

1. **Ensure all checks pass**:

   ```bash
   npm run lint
   npm test
   npm run build
   ```

2. **Update CHANGELOG** if needed

3. **Create Pull Request**:
   - Clear title and description
   - Link related issues
   - Request reviewers
   - Set appropriate labels

4. **Address feedback**:
   - Respond to all comments
   - Make requested changes
   - Re-request review when ready

---

## Release Process

Maintainers will:

1. Review and merge PRs
2. Update version in package.json
3. Update CHANGELOG
4. Tag release on GitHub
5. Build and publish to stores

---

## Questions?

- **Issues**: Open a GitHub issue
- **Discussions**: Use GitHub Discussions
- **Email**: Reach out to maintainers

---

## Thank You! 🙏

Your contributions help make FaceRecogApp better for everyone. We appreciate your effort and support!

---

**Happy Contributing! 🚀**
