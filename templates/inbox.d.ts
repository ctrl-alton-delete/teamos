export interface InboxMessage {
  from: string; // Member name
  content: string;
  sentAt: string; // ISO
  requestResponse?: boolean;
  projectCode?: string;
}

/*
  Example inbox file:
  inbox/new-website-page-needed.json:
  {
    from: 'MarketingMeg',
    content: 'As part of a new marketing campaign...',
    sentAt: '2024-01-01T12:00:00Z',
    requestResponse: false,
    projectCode: 'newWebsite'
  }
*/