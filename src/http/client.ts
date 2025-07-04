/**
 * @fileoverview HTTP client interface definitions for proxy-aware networking
 *
 * This module provides abstract interfaces for HTTP client implementations,
 * enabling dependency injection and proxy support while maintaining
 * compatibility with the standard Fetch API.
 *
 * @module http/client
 */

/**
 * HTTP client interface that abstracts the standard Fetch API
 *
 * This interface allows for dependency injection of different HTTP client
 * implementations, enabling features like proxy support, request/response
 * interceptors, and custom networking logic while maintaining compatibility
 * with the standard fetch() API.
 */
export type HttpClient = {
	/**
	 * Performs an HTTP request with the same signature as the standard fetch() API
	 *
	 * @param url - The URL to request
	 * @param options - Optional request configuration (headers, method, body, etc.)
	 * @returns Promise that resolves to a Response object compatible with Fetch API
	 */
	fetch: (url: string, options?: RequestInit) => Promise<Response>;
};

/**
 * Configuration for HTTP/HTTPS proxy connections
 *
 * This interface defines the structure for proxy server configuration,
 * supporting both authenticated and non-authenticated proxy connections.
 * Compatible with standard proxy URL formats.
 */
export type ProxyConfig = {
	/**
	 * Proxy server protocol (http or https)
	 */
	readonly protocol: 'http' | 'https';

	/**
	 * Proxy server hostname or IP address
	 */
	readonly hostname: string;

	/**
	 * Proxy server port number
	 */
	readonly port: number;

	/**
	 * Optional username for proxy authentication
	 */
	readonly username?: string;

	/**
	 * Optional password for proxy authentication
	 */
	readonly password?: string;
};

/**
 * Standard proxy environment variable names
 *
 * These are the conventional environment variable names used by
 * various tools and libraries for proxy configuration.
 */
export const PROXY_ENV_VARS = [
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'http_proxy',
	'https_proxy',
] as const;

/**
 * Type for proxy environment variable names
 */
export type ProxyEnvVar = typeof PROXY_ENV_VARS[number];
