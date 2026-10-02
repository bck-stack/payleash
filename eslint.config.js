import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.seed-state/**", "apps/*/public/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (.mjs) and the pages they drive in a browser.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: Object.fromEntries(["process", "console", "fetch", "setTimeout", "clearTimeout", "AbortSignal", "URL", "Buffer", "document", "window", "performance", "requestAnimationFrame", "setInterval", "clearInterval", "location"].map((g) => [g, "readonly"])),
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
);
