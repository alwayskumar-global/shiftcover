import type { Metadata } from 'next';
import { LoginExperience } from '@/features/manager/LoginExperience';

export const metadata: Metadata = { title: 'Sign in · ShiftCover Pay' };

export default function LoginPage() {
  return <LoginExperience />;
}
