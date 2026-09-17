import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  target: 'node24',
  platform: 'node',
  clean: true,
  dts: false,
})
