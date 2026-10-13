import type { Metadata } from 'next';
import { Profile } from '@/features/worker/Profile';

export const metadata: Metadata = { title: 'Profile · ShiftCover Pay' };

export default function ProfilePage() {
  return <Profile />;
}
