import { useEffect, useRef, useState, type VideoHTMLAttributes, type MutableRefObject } from "react";

type Props = Omit<VideoHTMLAttributes<HTMLVideoElement>, "src" | "preload"> & { src: string; videoRef?: MutableRefObject<HTMLVideoElement | null> };

/** Keep the table cell mounted, but release offscreen media buffers and decoders. */
export function ViewportVideo(props: Props) {
    return <ViewportVideoSource key={props.src} {...props} />;
}

function ViewportVideoSource({ src, videoRef, onLoadedMetadata, ...props }: Props) {
    const ref = useRef<HTMLVideoElement>(null);
    const position = useRef(0);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (videoRef) videoRef.current = ref.current;
        return () => { if (videoRef) videoRef.current = null; };
    }, [videoRef]);

    useEffect(() => {
        const video = ref.current;
        if (!video) return;
        if (typeof IntersectionObserver === "undefined") {
            setVisible(true);
            return;
        }
        const observer = new IntersectionObserver(([entry]) => {
            setVisible(entry.isIntersecting);
        }, { rootMargin: "200px" });
        observer.observe(video);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const video = ref.current;
        if (!video || !visible) return;
        // Explicit load also cancels a previous source when leaving the viewport.
        video.src = src;
        video.load();
        return () => {
            position.current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
            video.pause();
            video.removeAttribute("src");
            video.load();
        };
    }, [visible, src]);

    // Manage src in the effect so cleanup captures time BEFORE removing the source.
    return <video {...props} ref={ref} preload="metadata"
        onLoadedMetadata={(event) => {
            if (position.current > 0) event.currentTarget.currentTime = position.current;
            onLoadedMetadata?.(event);
        }} />;
}
