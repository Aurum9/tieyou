import { defineConfig } from 'drizzle-kit';

export default defineConfig({ dialect: 'sqlite', schema: './server/catalog-schema.js', out: './drizzle' });
