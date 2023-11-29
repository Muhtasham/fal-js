'use client';

/* eslint-disable @next/next/no-img-element */
import * as fal from '@fal-ai/serverless-client';
import { DrawingCanvas } from '../../components/drawing';
import { useState } from 'react';

fal.config({
  proxyUrl: '/api/fal/proxy',
});

const PROMPT = 'a moon in a starry night sky';

export default function RealtimePage() {
  // const [prompt, setPrompt] = useState(PROMPT);
  // const [rerender, setRerender] = useState(0);
  const [image, setImage] = useState<string | null>(null);

  const { send } = fal.realtime.connect('110602490-lcm-sd15-i2i', {
    connectionKey: 'realtime-demo',
    onResult(result) {
      console.log('onResult!!!', result);
      if (result.images && result.images[0]) {
        setImage(result.images[0].url);
      }
    },
  });

  // useEffect(() => {
  //   setTimeout(() => {
  //     setRerender((v) => v + 1);
  //   }, 10);
  // }, []);

  // useEffect(() => {
  //   setTimeout(() => {
  //     setRerender((v) => v + 1);
  //   }, 50);
  // }, []);

  return (
    <div className="min-h-screen bg-neutral-900 text-neutral-50">
      <main className="container flex flex-col items-center justify-center w-full flex-1 py-10 space-y-8">
        <h1 className="text-4xl font-mono mb-8 text-neutral-50">
          fal<code className="font-light text-pink-600">realtime</code>
        </h1>
        <div className="prose text-neutral-400">
          <blockquote className="italic text-xl">{PROMPT}</blockquote>
        </div>
        <div className="flex flex-col md:flex-row space-x-4">
          <div className="flex-1">
            <DrawingCanvas
              onCanvasChange={({ imageData }) => {
                send({
                  prompt: PROMPT,
                  image_url: imageData,
                  sync_mode: true,
                  seed: 6252023,
                });
              }}
            />
          </div>
          <div className="flex-1">
            <div className="w-[512px] h-[512px]">
              {image && (
                <img
                  src={image}
                  alt={`${PROMPT} generated by fal.ai`}
                  className="object-contain w-full h-full"
                />
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
