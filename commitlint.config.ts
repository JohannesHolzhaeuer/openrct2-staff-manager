import { RuleConfigSeverity, type UserConfig } from "@commitlint/types";

const config: UserConfig = {
    extends: ["@commitlint/config-conventional"],
    rules: {
        // Visual Studio's generated commit messages write each body/footer
        // paragraph as one unwrapped line, so the 100 character limits cannot be
        // met without hand-editing every message.
        "body-max-line-length": [RuleConfigSeverity.Disabled],
        "footer-max-line-length": [RuleConfigSeverity.Disabled],
        // They also capitalise the subject ("feat: Add ...") and may end it with a
        // full stop, neither of which affects the conventional-commit semantics
        // release-please relies on.
        "subject-case": [RuleConfigSeverity.Disabled],
        "subject-full-stop": [RuleConfigSeverity.Disabled],
    },
};

export default config;
