# Prompt Customization Guide

## Overview

The SafeInsights AI Companion allows you to customize the context that gets sent with every prompt to the AI. This ensures consistent behavior and specialized responses tailored to your specific needs.

## Customizing the Prompt Context

### 1. Edit the Main Context

Open `src/promptContext.ts` and modify the `PROMPT_CONTEXT` constant:

```typescript
export const PROMPT_CONTEXT = `Your custom prompt context here...`;
```

This context is added to **every** message sent to the AI, so make it:
- Clear and concise
- Specific to your use case
- Focused on the type of assistance you need

### 2. Language-Specific Context

You can also customize the `getFileTypeContext` function to provide specialized guidance for different programming languages:

```typescript
case 'your_language':
    return '\n\nYour language specific guidance here';
```

### 3. Examples

#### For Data Science Projects:
```typescript
export const PROMPT_CONTEXT = `You are a data science coding assistant specialized in R, Python, and statistical analysis.

Focus on:
- Clean, reproducible code
- Proper data validation and error handling
- Statistical best practices
- Clear documentation and comments
- Performance optimization for large datasets

Always suggest vectorized operations where possible and include proper error checking.`;
```

#### For Web Development:
```typescript
export const PROMPT_CONTEXT = `You are a web development assistant focused on modern, secure, and performant web applications.

Priorities:
- Security best practices (XSS, CSRF protection, input validation)
- Accessibility standards (WCAG compliance)
- Performance optimization
- Clean, maintainable code architecture
- Cross-browser compatibility

Provide production-ready code with proper error handling and testing considerations.`;
```

#### For Systems Programming:
```typescript
export const PROMPT_CONTEXT = `You are a systems programming assistant specialized in low-level, high-performance code.

Focus on:
- Memory safety and management
- Performance optimization
- Concurrent programming best practices
- Error handling and edge cases
- Cross-platform compatibility

Always consider resource usage, security implications, and maintainability.`;
```

## Compilation and Deployment

After editing `src/promptContext.ts`:

1. Save your changes
2. Run `npm run compile` to build the extension
3. Reload your debug console to apply the changes

## Structure of the Complete Message

The final message sent to the AI follows this structure:

1. **Main Context** (from `PROMPT_CONTEXT`)
2. **Language-Specific Context** (from `getFileTypeContext()`)
3. **File Context** (current file/selection)
4. **User Request** (the actual question/request)

## Tips for Effective Context

- **Be Specific**: Instead of "write good code", specify what "good" means for your domain
- **Set Expectations**: Clearly state the coding standards, patterns, or frameworks you prefer
- **Include Examples**: If you have specific formatting or style preferences, include examples
- **Keep It Focused**: Avoid overly long contexts that might confuse the AI
- **Test and Iterate**: Try different contexts and see what works best for your workflow

## Advanced Customization

For more advanced customization, you can:

1. Add conditional context based on file names or paths
2. Include project-specific information
3. Add context based on workspace configuration
4. Implement dynamic context that changes based on the current development phase

Edit the `_handleUserMessage` method in `src/chatViewProvider.ts` for these advanced scenarios.