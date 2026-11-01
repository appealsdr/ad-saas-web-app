// ─── Auth ────────────────────────────────────────────────────────
export type UserRole = 'owner' | 'admin' | 'member';

export interface User {
	id: string;
	email: string;
	displayName: string;
	avatarUrl?: string;
	role?: UserRole;
	sfdcContactId?: string;
	sfdcAccountId?: string;
	createdAt: string;
	lastLoginAt?: string;
}

export interface AccountContact {
	id: string;
	accountId: string;
	userId?: string;
	firstName?: string;
	lastName: string;
	email: string;
	phone?: string;
	title?: string;
	isPointOfContact: boolean;
	sfdcContactId?: string;
	userRole?: UserRole;
	inviteSentAt?: string;
	inviteAcceptedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface Session {
	id: string;
	userId: string;
	expiresAt: string;
}

// ─── Salesforce-mapped objects ───────────────────────────────────
export interface Account {
	id: string;          // local UUID
	sfdcId?: string;     // Salesforce Account ID
	name: string;
	email?: string;
	phone?: string;
	createdAt: string;
	updatedAt: string;
}

export interface Store {
	id: string;
	sfdcId?: string;     // Store__c
	accountId: string;
	name: string;
	marketplace?: string;
	status: 'active' | 'inactive' | 'suspended';
	healthScore?: number;
	createdAt: string;
}

export interface Issue {
	id: string;
	sfdcId?: string;     // Case
	accountId: string;
	storeId?: string;
	subject: string;
	description?: string;
	status: string;
	priority: 'Low' | 'Medium' | 'High' | 'Critical';
	createdAt: string;
	updatedAt: string;
}

export interface IssueComment {
	id: string;
	sfdcId?: string;     // Case_Message__c
	issueId: string;
	authorId: string;
	authorName: string;
	body: string;
	createdAt: string;
}

export interface Payment {
	id: string;
	sfdcId?: string;     // Opportunity
	accountId: string;
	name: string;
	amount: number;
	currency: string;
	stage: string;
	closeDate?: string;
	createdAt: string;
}

export interface Service {
	id: string;
	sfdcId?: string;     // PricebookEntry
	name: string;
	description?: string;
	unitPrice: number;
	currency: string;
	pricebookId: string;
	isActive: boolean;
}

// ─── API helpers ─────────────────────────────────────────────────
export interface ApiResponse<T> {
	data: T;
	error?: string;
}

export interface PaginatedResponse<T> {
	data: T[];
	total: number;
	page: number;
	pageSize: number;
}
