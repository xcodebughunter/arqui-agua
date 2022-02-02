/**
 * @jest-environment node
 */

import { Directus } from '../../src';
import { test, timers } from '../utils';

describe('auth (node)', function () {
	test(`sets default auth mode to json`, async (url) => {
		const sdk = new Directus(url);
		expect(sdk.auth.mode).toBe('json');
	});

	test(`sends default auth mode`, async (url, nock) => {
		const scope = nock()
			.post('/auth/login', (body) => body.mode === 'json')
			.reply(200, {
				data: {
					access_token: 'access_token',
					refresh_token: 'refresh_token',
					expires: 60000,
				},
			});

		await timers(async ({ tick }) => {
			const sdk = new Directus(url);
			const loginPromise = sdk.auth.login({
				email: 'wolfulus@gmail.com',
				password: 'password',
			});

			await tick(2500);

			await loginPromise;

			expect(scope.pendingMocks().length).toBe(0);
		});
	});

	test(`authentication should auto refresh after specified period`, async (url, nock) => {
		const scope = nock();

		scope
			.post('/auth/login', (body) => body.mode === 'json')
			.reply(200, {
				data: {
					access_token: 'some_node_access_token',
					refresh_token: 'some_node_refresh_token',
					expires: 5000,
				},
			});

		scope
			.post('/auth/refresh', {
				refresh_token: 'some_node_refresh_token',
			})
			.reply(200, {
				data: {
					access_token: 'a_new_node_access_token',
					refresh_token: 'a_new_node_refresh_token',
					expires: 5000,
				},
			});

		expect(scope.pendingMocks().length).toBe(2);

		await timers(async ({ tick, flush }) => {
			const sdk = new Directus(url, { auth: { autoRefresh: true, msRefreshBeforeExpires: 2500 } });

			const loginPromise = sdk.auth.login({
				email: 'wolfulus@gmail.com',
				password: 'password',
			});

			await tick(2500);

			await loginPromise;

			expect(scope.pendingMocks().length).toBe(1);
			expect(sdk.storage.auth_token).toBe('some_node_access_token');
			expect(sdk.storage.auth_expires).toBe(5000);
			await tick(5000);

			expect(scope.pendingMocks().length).toBe(0);
			await flush();

			await new Promise((resolve) => {
				scope.once('replied', () => {
					flush().then(resolve);
				});
			});

			expect(scope.pendingMocks().length).toBe(0);
			expect(sdk.storage.auth_token).toBe('a_new_node_access_token');
		});
	});

	test(`logout sends a refresh token in body`, async (url, nock) => {
		nock()
			.post('/auth/login', (body) => body.mode === 'json')
			.reply(
				200,
				{
					data: {
						access_token: 'auth_token',
						refresh_token: 'json_refresh_token',
					},
				},
				{
					'Set-Cookie': 'directus_refresh_token=my_refresh_token; Max-Age=604800; Path=/; HttpOnly;',
				}
			);

		nock()
			.post('/auth/logout', {
				refresh_token: 'json_refresh_token',
			})
			.reply(200, {
				data: {},
			});

		await timers(async ({ tick }) => {
			const sdk = new Directus(url);

			const loginPromise = sdk.auth.login({
				email: 'wolfulus@gmail.com',
				password: 'password',
			});

			await tick(2500);

			await loginPromise;

			expect(sdk.auth.token).toBe('auth_token');

			const logoutPromise = sdk.auth.logout();

			await tick(2500);

			await logoutPromise;

			expect(sdk.auth.token).toBeNull();
		});
	});
});
