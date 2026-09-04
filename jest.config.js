/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '.*\.(e2e-)?spec\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFiles: ['<rootDir>/test/setup.ts'],
  testTimeout: 15000,
};
