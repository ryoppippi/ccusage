/**
 * @fileoverview HTTP module with proxy support and factory functions
 *
 * This module provides a unified interface for HTTP operations with
 * automatic proxy detection and graceful fallback to direct connections.
 *
 * @module http
 */

import type { HttpClient } from './client.ts';
import { ProxyAwareHttpClient } from './proxy-aware-client.ts';

/**
 * Creates an HTTP client with proxy support
 *
 * This factory function creates a new instance of ProxyAwareHttpClient
 * that automatically detects proxy configuration from environment variables
 * and provides graceful fallback to direct connections.
 *
 * @returns HttpClient instance with proxy support
 */
export function createHttpClient(): HttpClient {
	return new ProxyAwareHttpClient();
}

/**
 * Default HTTP client instance
 *
 * This is a singleton instance that can be used throughout the application
 * for HTTP operations with automatic proxy support.
 */
export const httpClient = createHttpClient();

// Re-export types for convenience
export type { HttpClient, ProxyConfig } from './client.ts';
export { ProxyAwareHttpClient } from './proxy-aware-client.ts';
