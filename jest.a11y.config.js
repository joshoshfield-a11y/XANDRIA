module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['**/__tests__/**/*.a11y.test.{js,jsx,ts,tsx}'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup-a11y.js'],
  collectCoverageFrom: [
    'src/**/*.{js,jsx,ts,tsx}',
    '!src/**/*.d.ts',
  ],
  moduleNameMapping: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testTimeout: 10000,
};