// Test setup: provide dummy environment variables so module-level initializers don't throw.
// These are never used for real API calls in tests.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-dummy-key-for-unit-tests";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/ci_test";
