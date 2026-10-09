import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
export default tseslint.config({ignores:["build/**","dist/**","node_modules/**","fixtures/transfers/**"]},js.configs.recommended,...tseslint.configs.recommended,{languageOptions:{globals:globals.node},rules:{"@typescript-eslint/no-empty-function":"off"}},{files:["**/*.ts"],rules:{"no-undef":"off"}});
