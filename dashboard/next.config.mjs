import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The parent qa-testing-suite repo has its own package-lock.json, which made Turbopack
  // guess the wrong workspace root. Pin it explicitly to this project.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
