import { notFound } from 'next/navigation';
import { ReviewSceneClient } from '@/review/ReviewSceneClient';
import { sceneById } from '@/review/fixtures';

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const scene = sceneById((await params).id);
  if (!scene) notFound();
  return <ReviewSceneClient scene={scene} />;
}
