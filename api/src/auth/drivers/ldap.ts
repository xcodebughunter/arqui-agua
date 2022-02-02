import { Router } from 'express';
import ldap, {
	Client,
	Error,
	EqualityFilter,
	SearchCallbackResponse,
	SearchEntry,
	LDAPResult,
	InappropriateAuthenticationError,
	InvalidCredentialsError,
	InsufficientAccessRightsError,
	OperationsError,
} from 'ldapjs';
import ms from 'ms';
import { getIPFromReq } from '../../utils/get-ip-from-req';
import Joi from 'joi';
import { AuthDriver } from '../auth';
import { AuthDriverOptions, User } from '../../types';
import {
	InvalidCredentialsException,
	InvalidPayloadException,
	ServiceUnavailableException,
	InvalidConfigException,
	UnexpectedResponseException,
} from '../../exceptions';
import { AuthenticationService, UsersService } from '../../services';
import asyncHandler from '../../utils/async-handler';
import env from '../../env';
import { respond } from '../../middleware/respond';
import logger from '../../logger';

interface UserInfo {
	firstName?: string;
	lastName?: string;
	email?: string;
	userAccountControl: number;
}

// 0x2: ACCOUNTDISABLE
// 0x10: LOCKOUT
// 0x800000: PASSWORD_EXPIRED
const INVALID_ACCOUNT_FLAGS = 0x800012;

export class LDAPAuthDriver extends AuthDriver {
	bindClient: Client;
	usersService: UsersService;
	config: Record<string, any>;

	constructor(options: AuthDriverOptions, config: Record<string, any>) {
		super(options, config);

		const { bindDn, bindPassword, userDn, provider, clientUrl } = config;

		if (!bindDn || !bindPassword || !userDn || !provider || (!clientUrl && !config.client?.socketPath)) {
			throw new InvalidConfigException('Invalid provider config', { provider });
		}

		const clientConfig = typeof config.client === 'object' ? config.client : {};

		this.bindClient = ldap.createClient({ url: clientUrl, reconnect: true, ...clientConfig });
		this.bindClient.on('error', (err: Error) => {
			logger.warn(err);
		});
		this.usersService = new UsersService({ knex: this.knex, schema: this.schema });
		this.config = config;
	}

	private async validateBindClient(): Promise<void> {
		const { bindDn, bindPassword, provider } = this.config;

		return new Promise((resolve, reject) => {
			// Healthcheck bind user
			this.bindClient.search(bindDn, {}, (err: Error | null, res: SearchCallbackResponse) => {
				if (err) {
					reject(handleError(err));
					return;
				}

				res.on('searchEntry', () => {
					resolve();
				});

				res.on('error', (err: Error) => {
					if (!(err instanceof OperationsError)) {
						reject(handleError(err));
						return;
					}

					// Rebind on OperationsError
					this.bindClient.bind(bindDn, bindPassword, (err: Error | null) => {
						if (err) {
							const error = handleError(err);

							if (error instanceof InvalidCredentialsException) {
								reject(new InvalidConfigException('Invalid bind user', { provider }));
							} else {
								reject(error);
							}
						} else {
							resolve();
						}
					});
				});

				res.on('end', (result: LDAPResult | null) => {
					if (result?.status === 0) {
						// Handle edge case with IBM systems where authenticated bind user could not fetch their DN
						reject(new UnexpectedResponseException('Failed to find bind user record'));
					}
				});
			});
		});
	}

	private async fetchUserDn(identifier: string): Promise<string | undefined> {
		const { userDn, userAttribute, userScope } = this.config;

		return new Promise((resolve, reject) => {
			// Search for the user in LDAP by attribute
			this.bindClient.search(
				userDn,
				{
					filter: new EqualityFilter({ attribute: userAttribute ?? 'cn', value: identifier }),
					scope: userScope ?? 'one',
				},
				(err: Error | null, res: SearchCallbackResponse) => {
					if (err) {
						reject(handleError(err));
						return;
					}

					res.on('searchEntry', ({ object }: SearchEntry) => {
						resolve(object.dn.toLowerCase());
					});

					res.on('error', (err: Error) => {
						reject(handleError(err));
					});

					res.on('end', () => {
						resolve(undefined);
					});
				}
			);
		});
	}

	private async fetchUserInfo(userDn: string): Promise<UserInfo | undefined> {
		const { mailAttribute } = this.config;

		return new Promise((resolve, reject) => {
			// Fetch user info in LDAP by domain component
			this.bindClient.search(
				userDn,
				{ attributes: ['givenName', 'sn', mailAttribute ?? 'mail', 'userAccountControl'] },
				(err: Error | null, res: SearchCallbackResponse) => {
					if (err) {
						reject(handleError(err));
						return;
					}

					res.on('searchEntry', ({ object }: SearchEntry) => {
						const email = object[mailAttribute ?? 'mail'];
						const user = {
							firstName: typeof object.givenName === 'object' ? object.givenName[0] : object.givenName,
							lastName: typeof object.sn === 'object' ? object.sn[0] : object.sn,
							email: typeof email === 'object' ? email[0] : email,
							userAccountControl:
								typeof object.userAccountControl === 'object'
									? Number(object.userAccountControl[0])
									: Number(object.userAccountControl),
						};
						resolve(user);
					});

					res.on('error', (err: Error) => {
						reject(handleError(err));
					});

					res.on('end', () => {
						resolve(undefined);
					});
				}
			);
		});
	}

	private async fetchUserGroups(userDn: string): Promise<string[]> {
		const { groupDn, groupAttribute, groupScope } = this.config;

		if (!groupDn) {
			return Promise.resolve([]);
		}

		return new Promise((resolve, reject) => {
			let userGroups: string[] = [];

			// Search for the user info in LDAP by group attribute
			this.bindClient.search(
				groupDn,
				{
					attributes: ['cn'],
					filter: new EqualityFilter({ attribute: groupAttribute ?? 'member', value: userDn }),
					scope: groupScope ?? 'one',
				},
				(err: Error | null, res: SearchCallbackResponse) => {
					if (err) {
						reject(handleError(err));
						return;
					}

					res.on('searchEntry', ({ object }: SearchEntry) => {
						if (typeof object.cn === 'object') {
							userGroups = [...userGroups, ...object.cn];
						} else if (object.cn) {
							userGroups.push(object.cn);
						}
					});

					res.on('error', (err: Error) => {
						reject(handleError(err));
					});

					res.on('end', () => {
						resolve(userGroups);
					});
				}
			);
		});
	}

	private async fetchUserId(userDn: string): Promise<string | undefined> {
		const user = await this.knex
			.select('id')
			.from('directus_users')
			.orWhereRaw('LOWER(??) = ?', ['external_identifier', userDn.toLowerCase()])
			.first();

		return user?.id;
	}

	async getUserID(payload: Record<string, any>): Promise<string> {
		if (!payload.identifier) {
			throw new InvalidCredentialsException();
		}

		await this.validateBindClient();

		const userDn = await this.fetchUserDn(payload.identifier);

		if (!userDn) {
			throw new InvalidCredentialsException();
		}

		const userId = await this.fetchUserId(userDn);
		const userGroups = await this.fetchUserGroups(userDn);

		let userRole;

		if (userGroups.length) {
			userRole = await this.knex
				.select('id')
				.from('directus_roles')
				.whereRaw(`LOWER(??) IN (${userGroups.map(() => '?')})`, [
					'name',
					...userGroups.map((group) => group.toLowerCase()),
				])
				.first();
		}

		if (userId) {
			await this.usersService.updateOne(userId, { role: userRole?.id ?? null });
			return userId;
		}

		const userInfo = await this.fetchUserInfo(userDn);

		if (!userInfo) {
			throw new InvalidCredentialsException();
		}

		await this.usersService.createOne({
			provider: this.config.provider,
			first_name: userInfo.firstName,
			last_name: userInfo.lastName,
			email: userInfo.email,
			external_identifier: userDn,
			role: userRole?.id,
		});

		return (await this.fetchUserId(userDn)) as string;
	}

	async verify(user: User, password?: string): Promise<void> {
		if (!user.external_identifier || !password) {
			throw new InvalidCredentialsException();
		}

		return new Promise((resolve, reject) => {
			const clientConfig = typeof this.config.client === 'object' ? this.config.client : {};
			const client = ldap.createClient({
				url: this.config.clientUrl,
				...clientConfig,
				reconnect: false,
			});

			client.on('error', (err: Error) => {
				reject(handleError(err));
			});

			client.bind(user.external_identifier!, password, (err: Error | null) => {
				if (err) {
					reject(handleError(err));
				} else {
					resolve();
				}
				client.destroy();
			});
		});
	}

	async login(user: User, payload: Record<string, any>): Promise<void> {
		await this.verify(user, payload.password);
	}

	async refresh(user: User): Promise<void> {
		await this.validateBindClient();

		const userInfo = await this.fetchUserInfo(user.external_identifier!);

		if (userInfo?.userAccountControl && userInfo.userAccountControl & INVALID_ACCOUNT_FLAGS) {
			throw new InvalidCredentialsException();
		}
	}
}

const handleError = (e: Error) => {
	if (
		e instanceof InappropriateAuthenticationError ||
		e instanceof InvalidCredentialsError ||
		e instanceof InsufficientAccessRightsError
	) {
		return new InvalidCredentialsException();
	}
	return new ServiceUnavailableException('Service returned unexpected error', {
		service: 'ldap',
		message: e.message,
	});
};

export function createLDAPAuthRouter(provider: string): Router {
	const router = Router();

	const loginSchema = Joi.object({
		identifier: Joi.string().required(),
		password: Joi.string().required(),
		mode: Joi.string().valid('cookie', 'json'),
		otp: Joi.string(),
	}).unknown();

	router.post(
		'/',
		asyncHandler(async (req, res, next) => {
			const accountability = {
				ip: getIPFromReq(req),
				userAgent: req.get('user-agent'),
				role: null,
			};

			const authenticationService = new AuthenticationService({
				accountability: accountability,
				schema: req.schema,
			});

			const { error } = loginSchema.validate(req.body);

			if (error) {
				throw new InvalidPayloadException(error.message);
			}

			const mode = req.body.mode || 'json';

			const { accessToken, refreshToken, expires } = await authenticationService.login(
				provider,
				req.body,
				req.body?.otp
			);

			const payload = {
				data: { access_token: accessToken, expires },
			} as Record<string, Record<string, any>>;

			if (mode === 'json') {
				payload.data.refresh_token = refreshToken;
			}

			if (mode === 'cookie') {
				res.cookie(env.REFRESH_TOKEN_COOKIE_NAME, refreshToken, {
					httpOnly: true,
					domain: env.REFRESH_TOKEN_COOKIE_DOMAIN,
					maxAge: ms(env.REFRESH_TOKEN_TTL as string),
					secure: env.REFRESH_TOKEN_COOKIE_SECURE ?? false,
					sameSite: (env.REFRESH_TOKEN_COOKIE_SAME_SITE as 'lax' | 'strict' | 'none') || 'strict',
				});
			}

			res.locals.payload = payload;

			return next();
		}),
		respond
	);

	return router;
}
