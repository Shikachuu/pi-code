---
name: commit-message
description: Write a git commit message for staged changes. Use when the user asks to commit, write a commit message, or summarize staged changes for git.
---

# Commit message

1. Run `git diff --cached` to read the staged change.
2. Write a subject of the form `<type>: <summary>`. The type is `feat`, `fix`, `chore` or `refactor`. The summary is lowercase, present tense, and at most 72 characters.
3. Add a body only when the reason for the change is not obvious from the diff.
4. Show the message and wait for approval before running `git commit`.
