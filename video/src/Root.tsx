import "./index.css";
import { Composition } from "remotion";
import { DeepMarketPromo } from "./DeepMarketPromo";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="DeepMarketPromo"
        component={DeepMarketPromo}
        durationInFrames={460}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
