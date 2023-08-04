import { redirect, type DataFunctionArgs } from '@remix-run/node'
import { GitHubStrategy } from 'remix-auth-github'
import {
	SESSION_EXPIRATION_TIME,
	authenticator,
	getUserId,
	sessionKey,
} from '~/utils/auth.server.ts'
import { prisma } from '~/utils/db.server.ts'
import { verifySessionStorage } from '~/utils/verification.server.ts'
import { twoFAVerificationType } from '../settings+/profile.two-factor.tsx'
import { unverifiedSessionIdKey } from './login.tsx'
import {
	githubIdKey,
	onboardingEmailSessionKey,
	prefilledProfileKey,
} from './onboarding_.github.tsx'
import { getRedirectToUrl } from './verify.tsx'
import { commitSession, getSession } from '~/utils/session.server.ts'
import { createToastHeaders, redirectWithToast } from '~/utils/toast.server.ts'
import { combineHeaders } from '~/utils/misc.tsx'

async function makeSession(
	{ request, userId }: { request: Request; userId: string },
	responseInit?: ResponseInit,
) {
	const session = await prisma.session.create({
		select: { id: true, expirationDate: true, userId: true },
		data: {
			expirationDate: new Date(Date.now() + SESSION_EXPIRATION_TIME),
			userId,
		},
	})
	const verification = await prisma.verification.findUnique({
		select: { id: true },
		where: {
			target_type: {
				target: session.userId,
				type: twoFAVerificationType,
			},
		},
	})

	// has 2FA? redirect to verify
	const userHasTwoFactor = Boolean(verification)
	if (userHasTwoFactor) {
		const verifySession = await verifySessionStorage.getSession(
			request.headers.get('cookie'),
		)
		verifySession.set(unverifiedSessionIdKey, session.id)
		const reqUrl = new URL(request.url)
		const redirectUrl = getRedirectToUrl({
			request,
			type: twoFAVerificationType,
			target: session.userId,
			redirectTo: reqUrl.searchParams.get('redirectTo') ?? '/',
		})
		return redirect(redirectUrl.toString(), {
			...responseInit,
			headers: combineHeaders(
				{
					'set-cookie': await verifySessionStorage.commitSession(verifySession),
				},
				responseInit?.headers,
			),
		})
	}

	// they're just logging in with an existing connection 👍
	const cookieSession = await getSession(request.headers.get('cookie'))
	cookieSession.set(sessionKey, session.id)
	return redirect('/', {
		...responseInit,
		headers: combineHeaders(
			{
				'set-cookie': await commitSession(cookieSession),
			},
			responseInit?.headers,
		),
	})
}

export async function loader({ request }: DataFunctionArgs) {
	const reqUrl = new URL(request.url)
	if (
		process.env.GITHUB_CLIENT_ID.startsWith('MOCK_') &&
		reqUrl.searchParams.get('state') === 'MOCK_STATE'
	) {
		const cookieSession = await getSession(request.headers.get('cookie'))
		const state = cookieSession.get('oauth2:state') ?? 'MOCK_STATE'
		cookieSession.set('oauth2:state', state)
		reqUrl.searchParams.set('state', state)
		request.headers.set('cookie', await commitSession(cookieSession))
		request = new Request(reqUrl.toString(), request)
	}

	const authResult = await authenticator
		.authenticate(GitHubStrategy.name, request, { throwOnError: true })
		.then(
			data => ({ success: true, data }) as const,
			error => ({ success: false, error }) as const,
		)

	if (!authResult.success) {
		console.error(authResult.error)
		return redirectWithToast('/login', {
			title: 'Auth Failed',
			description: 'There was an error authenticating with GitHub.',
			type: 'error',
		})
	}

	const { data: profile } = authResult

	const existingConnection = await prisma.gitHubConnection.findUnique({
		select: { userId: true },
		where: { providerId: profile.id },
	})

	const userId = await getUserId(request)

	if (existingConnection && userId) {
		if (existingConnection.userId === userId) {
			return redirectWithToast('/settings/profile/connections', {
				title: 'Already Connected',
				description: `Your "${profile.username}" GitHub account is already connected.`,
			})
		} else {
			return redirectWithToast('/settings/profile/connections', {
				title: 'Already Connected',
				description: `The "${profile.username}" GitHub account is already connected to another account.`,
			})
		}
	}

	// If we're already logged in, then link the GitHub account
	if (userId) {
		await prisma.gitHubConnection.create({
			data: { providerId: profile.id, userId },
		})
		return redirectWithToast('/settings/profile/connections', {
			title: 'Connected',
			description: `Your "${profile.username}" GitHub account has been connected.`,
		})
	}

	// Connection exists already? Make a new session
	if (existingConnection) {
		return makeSession({ request, userId: existingConnection.userId })
	}

	// if the github email matches a user in the db, then link the account and
	// make a new session
	const user = await prisma.user.findUnique({
		select: { id: true },
		where: { email: profile.email },
	})
	if (user) {
		await prisma.gitHubConnection.create({
			data: { providerId: profile.id, userId: user.id },
		})
		return makeSession(
			{ request, userId: user.id },
			{
				headers: await createToastHeaders({
					title: 'Connected',
					description: `Your "${profile.username}" GitHub account has been connected.`,
				}),
			},
		)
	}

	// this is a new user, so let's get them onboarded
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	verifySession.set(onboardingEmailSessionKey, profile.email)
	verifySession.set(prefilledProfileKey, profile)
	verifySession.set(githubIdKey, profile.id)
	throw redirect('/onboarding/github', {
		headers: {
			'Set-Cookie': await verifySessionStorage.commitSession(verifySession),
		},
	})
}