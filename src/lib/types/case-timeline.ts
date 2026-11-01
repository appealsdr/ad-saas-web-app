export type CaseTimelineEventType =
	| 'case_opened'
	| 'status_changed'
	| 'priority_changed'
	| 'owner_changed'
	| 'field_changed'
	| 'comment_added'
	| 'document_uploaded'
	| 'document_requested';

export interface CaseTimelineEvent {
	id: string;
	type: CaseTimelineEventType;
	date: string;
	text: string;
	actor: string | null;
	detail: string | null;
}
