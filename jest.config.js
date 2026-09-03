/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.(e2e-)?spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 15000,
};
