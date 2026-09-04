export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Visual Studio's generated commit messages write each body/footer
    // paragraph as one unwrapped line, so the 100 character limits cannot be
    // met without hand-editing every message.
    'body-max-line-length': [0, 'always'],
    'footer-max-line-length': [0, 'always'],
    // They also capitalise the subject ("feat: Add ...") and may end it with a
    // full stop, neither of which affects the conventional-commit semantics
    // release-please relies on.
    'subject-case': [0, 'never'],
    'subject-full-stop': [0, 'never', '.'],
  },
};
