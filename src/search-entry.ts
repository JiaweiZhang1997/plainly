import { SearchPanel } from './search.ts';
const key = '__plainly_search_v1__';
const panel: SearchPanel = (globalThis as any)[key] ||= new SearchPanel();
void panel.open();
