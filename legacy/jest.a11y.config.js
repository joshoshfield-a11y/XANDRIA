module.exports = {
  testEnvironment: 'jsdom',
  // Match accessibility tests and also fall back to tests in tests/ test files
  testMatch: [
    '**/tests/**/*.a11y.test.{js,jsx,ts,tsx,mjs}',
    '**/tests/**/*.test.{js,jsx,ts,tsx,mjs}'
  ],
  setupFilesAfterEnv: ['<rootDir>/tests/setup-a11y.js'],
  collectCoverageFrom: [
    'src/**/*.{js,jsx,ts,tsx}',
    '!src/**/*.d.ts',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testTimeout: 20000, // increase timeout for graphics tests if needed
};