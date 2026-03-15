/** A scheduled event */
export interface ScheduleEvent {
  /** Event title */
  title: string;
  /** Event description */
  description?: string;
  /** Start time in ISO format */
  time: string;
  /** Whether this is a recurring event */
  recurring?: boolean;
  /** Recurrence pattern if recurring */
  recurrence?: {
    frequency: 'daily' | 'weekly' | 'monthly';
    interval: number;
    endDate?: string;
  };
  /** Related project Code */
  projectCode?: string;
}

/** Root structure for schedule.json */
export interface Schedule {
  events: ScheduleEvent[];
}

